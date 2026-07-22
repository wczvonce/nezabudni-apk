import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migrations = [
  '001_schema.sql',
  '004_deep_audit_fixes.sql',
  '005_offline_absolute_times.sql',
  '006_terminal_edit_guard.sql',
  '007_reject_and_hide.sql',
  '008_fix_null_pair_guard.sql',
  '009_bug_hunt_2.sql',
  '010_low_priority_fixes.sql',
  '011_backend_capabilities.sql',
  '012_chatgpt_action_integration.sql',
];

const ids = {
  actor: '11111111-1111-4111-8111-111111111111',
  partner: '22222222-2222-4222-8222-222222222222',
  pair: '33333333-3333-4333-8333-333333333333',
  client: '44444444-4444-4444-8444-444444444444',
  request: '55555555-5555-4555-8555-555555555555',
  task: '66666666-6666-4666-8666-666666666666',
  retryTask: '77777777-7777-4777-8777-777777777777',
  completionMutation: '88888888-8888-4888-8888-888888888888',
  secondRequest: '99999999-9999-4999-8999-999999999999',
  secondTask: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name,'/') $$;
  `);

  for (const filename of migrations) {
    let sql = await readFile(`supabase/migrations/${filename}`, 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto;\s*/i, '');
    await db.exec(sql);
  }

  await db.exec(`
    insert into auth.users(id,email) values
      ('${ids.actor}','actor@example.com'),
      ('${ids.partner}','partner@example.com');
    insert into public.profiles(id,display_name,email) values
      ('${ids.actor}','Ivan','actor@example.com'),
      ('${ids.partner}','Dominika','partner@example.com');
    insert into public.pairs(id,name) values ('${ids.pair}','Ivan a Dominika');
    insert into public.pair_members(pair_id,user_id,role) values
      ('${ids.pair}','${ids.actor}','owner'),
      ('${ids.pair}','${ids.partner}','member');
    insert into public.integration_clients(
      id,name,actor_id,token_hash,allowed_operations,expires_at,max_per_minute,max_per_day
    ) values (
      '${ids.client}','ChatGPT test','${ids.actor}',repeat('a',64),array['create_task']::text[],
      now() + interval '180 days',1,10
    );
  `);

  const createSql = ({
    payloadHash = 'b'.repeat(64),
    taskId = ids.task,
    requestId = ids.request,
    title = 'Vysypať smeti',
  } = {}) => `
    select (public.api_create_task_from_integration(
      '${ids.client}'::uuid,
      '${ids.actor}'::uuid,
      '${requestId}'::uuid,
      '${payloadHash}',
      '${taskId}'::uuid,
      '${ids.partner}'::uuid,
      '${title}',
      null,
      now() + interval '1 hour',
      'Europe/Bratislava',
      1,
      0,
      'none',
      'after',
      true,
      60,
      10
    )).*;
  `;

  const capabilities = await db.query(`select public.get_backend_capabilities() as value`);
  assert.equal(capabilities.rows[0].value.schema_version, 12);

  const first = await db.query(createSql());
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].id, ids.task);
  assert.equal(first.rows[0].created_by, ids.actor);
  assert.equal(first.rows[0].assigned_to, ids.partner);
  assert.equal(first.rows[0].notify_creator_on_complete, true);

  const initialJobs = await db.query(`
    select kind,recipient_id,status
    from public.notification_jobs
    where task_id='${ids.task}'
    order by kind
  `);
  assert.deepEqual(initialJobs.rows.map((row) => row.kind).sort(), ['task_assigned', 'task_due']);
  assert.ok(initialJobs.rows.every((row) => row.recipient_id === ids.partner));

  const event = await db.query(`select payload from public.task_events where task_id='${ids.task}' and event_type='created'`);
  assert.equal(event.rows.length, 1);
  assert.equal(event.rows[0].payload.source, 'chatgpt_action');

  // Dominika splní úlohu vytvorenú cez integráciu. Musí vzniknúť práve jedna
  // notifikácia task_completed pre autora Ivana.
  await db.exec(`
    create or replace function auth.uid() returns uuid language sql stable
    as $$ select '${ids.partner}'::uuid $$;
  `);
  const completed = await db.query(`
    select (public.api_complete_task('${ids.task}'::uuid,'${ids.completionMutation}'::uuid)).*;
  `);
  assert.equal(completed.rows[0].status, 'completed');
  const completionJobs = await db.query(`
    select recipient_id,status
    from public.notification_jobs
    where task_id='${ids.task}' and kind='task_completed'
  `);
  assert.equal(completionJobs.rows.length, 1);
  assert.equal(completionJobs.rows[0].recipient_id, ids.actor);
  assert.equal(completionJobs.rows[0].status, 'queued');

  // Retry rovnakej zamýšľanej úlohy nesmie vytvoriť druhý task, aj keď Edge
  // Function pri novom HTTP pokuse vygeneruje iné p_id.
  const retry = await db.query(createSql({ taskId: ids.retryTask }));
  assert.equal(retry.rows[0].id, ids.task);
  const taskCount = await db.query(`select count(*)::int as count from public.tasks`);
  assert.equal(taskCount.rows[0].count, 1);

  await assert.rejects(
    db.query(createSql({ payloadHash: 'c'.repeat(64), taskId: ids.retryTask, title: 'Iný obsah' })),
    /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD/,
  );

  // Nová úloha v tej istej minúte už prekročí individuálny limit 1/min;
  // bezpečný retry vyššie sa do limitu nezapočítal.
  await assert.rejects(
    db.query(createSql({ requestId: ids.secondRequest, taskId: ids.secondTask, payloadHash: 'd'.repeat(64) })),
    /INTEGRATION_RATE_LIMITED/,
  );

  const requestRows = await db.query(`select task_id,payload_hash from public.integration_requests where client_id='${ids.client}'`);
  assert.equal(requestRows.rows.length, 1);
  assert.equal(requestRows.rows[0].task_id, ids.task);
  assert.equal(requestRows.rows[0].payload_hash, 'b'.repeat(64));

  // Expirácia musí byť vynútená aj v RPC, nielen v Edge Function.
  await db.exec(`
    update public.integration_clients
    set created_at=now()-interval '2 days', expires_at=now()-interval '1 day'
    where id='${ids.client}';
  `);
  await assert.rejects(
    db.query(createSql({ requestId: ids.secondRequest, taskId: ids.secondTask, payloadHash: 'd'.repeat(64) })),
    /INTEGRATION_EXPIRED/,
  );

  console.log('CHATGPT INTEGRATION SQL OK');
} catch (error) {
  console.error('CHATGPT INTEGRATION SQL FAILED');
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}

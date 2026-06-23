import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = new PGlite();
const IVAN = '11111111-1111-4111-8111-111111111111';
const DOMI = '22222222-2222-4222-8222-222222222222';
const PAIR = '33333333-3333-4333-8333-333333333333';
const REJECTED_TASK = '44444444-4444-4444-8444-444444444441';
const COMPLETED_TASK = '44444444-4444-4444-8444-444444444442';
const setUser = (userId) => db.query(`select set_config('app.user_id',$1,false)`, [userId]);

try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.user_id',true),'')::uuid $$;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name,'/') $$;
  `);

  let schema = await readFile('supabase/migrations/001_schema.sql', 'utf8');
  schema = schema.replace(/create extension if not exists pgcrypto;\s*/i, '');
  await db.exec(schema);
  for (const migration of [
    '004_deep_audit_fixes',
    '005_offline_absolute_times',
    '006_terminal_edit_guard',
    '007_reject_and_hide',
    '008_fix_null_pair_guard',
    '009_terminal_complete_guard',
  ]) {
    await db.exec(await readFile(`supabase/migrations/${migration}.sql`, 'utf8'));
  }

  await db.exec(`
    insert into auth.users values ('${IVAN}','ivan@example.invalid'),('${DOMI}','domi@example.invalid');
    insert into public.profiles(id,display_name,email) values
      ('${IVAN}','Ivan','ivan@example.invalid'),('${DOMI}','Dominika','domi@example.invalid');
    insert into public.pairs(id,name) values ('${PAIR}','I+D');
    insert into public.pair_members(pair_id,user_id,role) values
      ('${PAIR}','${IVAN}','owner'),('${PAIR}','${DOMI}','member');
  `);

  await setUser(IVAN);
  for (const taskId of [REJECTED_TASK, COMPLETED_TASK]) {
    await db.query(
      `select public.api_create_task($1,gen_random_uuid(),$2,'Test',null,now()+interval '1 hour','Europe/Bratislava',1,0,'none','after',false,60,5)`,
      [taskId, DOMI],
    );
  }

  await setUser(DOMI);
  await db.query(`select public.api_reject_task($1,'Nemôžem',gen_random_uuid())`, [REJECTED_TASK]);
  await assert.rejects(
    db.query(`select public.api_complete_task($1,gen_random_uuid())`, [REJECTED_TASK]),
    /TASK_NOT_COMPLETABLE/,
    'odmietnutá úloha sa nesmie zmeniť na completed',
  );
  assert.equal(
    (await db.query(`select status from public.tasks where id=$1`, [REJECTED_TASK])).rows[0].status,
    'rejected',
    'stav odmietnutej úlohy ostáva zachovaný',
  );

  await db.query(`select public.api_complete_task($1,gen_random_uuid())`, [COMPLETED_TASK]);
  await db.query(`select public.api_complete_task($1,gen_random_uuid())`, [COMPLETED_TASK]);
  assert.equal(
    (await db.query(`select status from public.tasks where id=$1`, [COMPLETED_TASK])).rows[0].status,
    'completed',
    'opakované complete zostáva idempotentné',
  );

  console.log('TERMINAL COMPLETE GUARD OK');
} catch (error) {
  console.error('TERMINAL COMPLETE GUARD FAILED');
  console.error(error);
  process.exit(1);
} finally {
  await db.close();
}

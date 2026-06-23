import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Issue 6: api_snooze_task musí uprednostniť absolútny čas (offline snooze bez driftu).
const db = new PGlite();
const IVAN = '11111111-1111-4111-8111-111111111111';
const DOMI = '22222222-2222-4222-8222-222222222222';
const PAIR = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';

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
  let sql = await readFile('supabase/migrations/001_schema.sql', 'utf8');
  sql = sql.replace(/create extension if not exists pgcrypto;\s*/i, '');
  await db.exec(sql);
  await db.exec(await readFile('supabase/migrations/005_offline_absolute_times.sql', 'utf8'));
  await db.exec(`
    insert into auth.users values ('${IVAN}','i@e.com'),('${DOMI}','d@e.com');
    insert into public.profiles(id,display_name,email) values ('${IVAN}','Ivan','i@e.com'),('${DOMI}','Dominika','d@e.com');
    insert into public.pairs(id,name) values ('${PAIR}','I+D');
    insert into public.pair_members(pair_id,user_id,role) values ('${PAIR}','${IVAN}','owner'),('${PAIR}','${DOMI}','member');
    select set_config('app.user_id','${IVAN}',false);
  `);
  await db.query(`select public.api_create_task($1, gen_random_uuid(), $2, 'Test', null, now()+interval '1 hour', 'Europe/Bratislava', 1, 0, 'none', 'after', false, 60, 10)`, [TASK, IVAN]);

  // 1) ABSOLÚTNY čas (ďaleko v budúcnosti) sa MUSÍ zachovať – žiadny drift.
  const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  await db.query(`select public.api_snooze_task($1, 15, gen_random_uuid(), $2::timestamptz)`, [TASK, future]);
  const r1 = (await db.query(`select snoozed_until from public.tasks where id=$1`, [TASK])).rows[0];
  const diff = Math.abs(new Date(r1.snoozed_until).getTime() - new Date(future).getTime());
  assert.ok(diff < 2000, `absolútny snooze sa nezachoval (diff ${diff}ms)`);

  // 2) FALLBACK bez absolútneho času → now()+minutes (~15 min).
  await db.query(`update public.tasks set status='pending', snoozed_until=null where id=$1`, [TASK]);
  await db.query(`select public.api_snooze_task($1, 15, gen_random_uuid())`, [TASK]);
  const r2 = (await db.query(`select snoozed_until from public.tasks where id=$1`, [TASK])).rows[0];
  const mins = (new Date(r2.snoozed_until).getTime() - Date.now()) / 60000;
  assert.ok(mins > 13 && mins < 17, `fallback snooze nie je ~15 min (${mins})`);

  // 3) Absolútny čas v minulosti sa nesmie nastaviť do minulosti.
  await db.query(`update public.tasks set status='pending', snoozed_until=null where id=$1`, [TASK]);
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  await db.query(`select public.api_snooze_task($1, 15, gen_random_uuid(), $2::timestamptz)`, [TASK, past]);
  const r3 = (await db.query(`select snoozed_until from public.tasks where id=$1`, [TASK])).rows[0];
  assert.ok(new Date(r3.snoozed_until).getTime() > Date.now() - 1000, 'snooze nesmie ísť do minulosti');

  console.log('offline-snooze-absolute.test: OK');
} catch (e) {
  console.error('offline-snooze-absolute.test FAILED');
  console.error(e);
  process.exit(1);
} finally {
  await db.close();
}

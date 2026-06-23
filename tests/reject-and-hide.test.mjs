import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Issue 12: odmietnutie s povinným dôvodom + skrytie z vlastného zoznamu (backend).
const db = new PGlite();
const IVAN = '11111111-1111-4111-8111-111111111111';
const DOMI = '22222222-2222-4222-8222-222222222222';
const PAIR = '33333333-3333-4333-8333-333333333333';
const T1 = '44444444-4444-4444-8444-444444444441';
const T2 = '44444444-4444-4444-8444-444444444442';
const setUser = (u) => db.query(`select set_config('app.user_id',$1,false)`, [u]);
const create = (id) => db.query(`select public.api_create_task($1, gen_random_uuid(), $2, 'T', null, now()+interval '1 hour', 'Europe/Bratislava', 1, 0, 'none', 'after', false, 60, 10)`, [id, DOMI]);

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
  await db.exec(await readFile('supabase/migrations/004_deep_audit_fixes.sql', 'utf8'));
  await db.exec(await readFile('supabase/migrations/007_reject_and_hide.sql', 'utf8'));
  await db.exec(`
    insert into auth.users values ('${IVAN}','i@e.com'),('${DOMI}','d@e.com');
    insert into public.profiles(id,display_name,email) values ('${IVAN}','Ivan','i@e.com'),('${DOMI}','Dominika','d@e.com');
    insert into public.pairs(id,name) values ('${PAIR}','I+D');
    insert into public.pair_members(pair_id,user_id,role) values ('${PAIR}','${IVAN}','owner'),('${PAIR}','${DOMI}','member');
  `);

  // IVAN (autor) vytvorí dve úlohy priradené DOMI.
  await setUser(IVAN);
  await create(T1);
  await create(T2);

  // Iba príjemca smie odmietnuť – autor nie.
  await assert.rejects(db.query(`select public.api_reject_task($1,'nope',gen_random_uuid())`, [T2]), /ONLY_ASSIGNEE_CAN_REJECT/);

  await setUser(DOMI);
  // Dôvod je POVINNÝ (po orezaní) – backend enforce.
  await assert.rejects(db.query(`select public.api_reject_task($1,'   ',gen_random_uuid())`, [T1]), /REJECTION_REASON_REQUIRED/);
  // Skrytie aktívnej úlohy nie je dovolené.
  await assert.rejects(db.query(`select public.api_hide_task_for_self($1)`, [T1]), /TASK_STILL_ACTIVE/);
  // Odmietnutie s dôvodom.
  await db.query(`select public.api_reject_task($1,'Nemám čas',gen_random_uuid())`, [T1]);
  const t = (await db.query(`select status, rejection_reason, rejected_by from public.tasks where id=$1`, [T1])).rows[0];
  assert.equal(t.status, 'rejected');
  assert.equal(t.rejection_reason, 'Nemám čas', 'dôvod je uložený a viditeľný (synchronizuje sa)');
  assert.equal(t.rejected_by, DOMI);

  // DOMI odstráni úlohu zo SVOJHO zoznamu (po odmietnutí).
  await db.query(`select public.api_hide_task_for_self($1)`, [T1]);
  assert.equal((await db.query(`select count(*)::int c from public.task_hidden where task_id=$1 and user_id=$2`, [T1, DOMI])).rows[0].c, 1, 'úloha skrytá pre DOMI');

  // Autorov záznam ostáva a skrytie sa netýka iného používateľa.
  assert.equal((await db.query(`select count(*)::int c from public.tasks where id=$1`, [T1])).rows[0].c, 1, 'autorov záznam úlohy ostáva');
  assert.equal((await db.query(`select count(*)::int c from public.task_hidden where task_id=$1 and user_id=$2`, [T1, IVAN])).rows[0].c, 0, 'skrytie sa netýka iného používateľa');

  // Klientske API (Issue 12).
  const ts = await readFile('src/services/task-service.js', 'utf8');
  assert.match(ts, /export async function rejectTask/, 'klient: rejectTask');
  assert.match(ts, /export async function hideTaskForSelf/, 'klient: hideTaskForSelf');
  assert.match(ts, /reject: 'api_reject_task'/, 'reject zapojený do callRpc (aj offline replay)');
  assert.match(ts, /from\('task_hidden'\)\.select\('task_id'\)/, 'fetchTasks filtruje skryté úlohy');

  // UI (Issue 12): tlačidlá + povinný dôvod.
  const ui = await readFile('src/ui/app-ui.js', 'utf8');
  assert.match(ui, /data-reject-task/, 'UI: tlačidlo Odmietnuť');
  assert.match(ui, /data-hide-task/, 'UI: tlačidlo Odstrániť zo svojho zoznamu');
  assert.match(ui, /Dôvod odmietnutia/, 'UI: vyžiada dôvod odmietnutia');

  console.log('reject-and-hide.test: OK');
} catch (e) {
  console.error('reject-and-hide.test FAILED');
  console.error(e);
  process.exit(1);
} finally {
  await db.close();
}

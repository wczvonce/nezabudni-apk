// Bug-hunt regresia: trojhodnotová logika pri kontrole páru.
// Používateľ BEZ členstva v páre (current_pair_id() = NULL) nesmie prejsť cez
// kontrolu `v_task.pair_id <> current_pair_id()`. Migrácia 008 ju mení na
// `is distinct from`, takže každá operácia musí skončiť TASK_NOT_FOUND.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = new PGlite();
const IVAN = '11111111-1111-4111-8111-111111111111';
const DOMI = '22222222-2222-4222-8222-222222222222';
const OUT  = '99999999-9999-4999-8999-999999999999'; // outsider: má profil, NIE je v páre
const PAIR = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';

async function mustRaise(label, sql, params = []) {
  let raised = false;
  try { await db.query(sql, params); } catch { raised = true; }
  assert.equal(raised, true, label);
}

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
  for (const m of ['004_deep_audit_fixes', '005_offline_absolute_times', '006_terminal_edit_guard', '007_reject_and_hide', '008_fix_null_pair_guard', '009_bug_hunt_2']) {
    await db.exec(await readFile(`supabase/migrations/${m}.sql`, 'utf8'));
  }

  await db.exec(`
    insert into auth.users values ('${IVAN}','i@x.sk'),('${DOMI}','d@x.sk'),('${OUT}','o@x.sk');
    insert into public.profiles(id,display_name,email) values ('${IVAN}','Ivan','i@x.sk'),('${DOMI}','Dominika','d@x.sk'),('${OUT}','Outsider','o@x.sk');
    insert into public.pairs(id,name) values ('${PAIR}','I+D');
    insert into public.pair_members(pair_id,user_id,role) values ('${PAIR}','${IVAN}','owner'),('${PAIR}','${DOMI}','member');
    select set_config('app.user_id','${IVAN}',false);
  `);
  const due = new Date(Date.now() + 3600_000).toISOString();
  await db.query(`select public.api_create_task($1,gen_random_uuid(),$2,'Tajná úloha','',$3,'Europe/Bratislava',1,0,'none','after',false,60,5)`, [TASK, DOMI, due]);

  // current_pair_id() outsidera je NULL.
  await db.exec(`select set_config('app.user_id','${OUT}',false);`);
  const cp = (await db.query(`select public.current_pair_id() p`)).rows[0];
  assert.equal(cp.p, null, 'outsider nemá pár (current_pair_id NULL)');

  // 1) Outsider (nie je priradený) nesmie cudziu úlohu upraviť – musí dostať TASK_NOT_FOUND,
  //    NIE prejsť cez NULL a doraziť až k INVALID_ASSIGNEE/úspechu.
  await mustRaise('update cudzej úlohy outsiderom je zablokovaný',
    `select public.api_update_task($1,gen_random_uuid(),1,$2,'Hack','',$3,'Europe/Bratislava',1,0,'none','after',false,60,5)`, [TASK, DOMI, due]);
  // Úloha sa NESMIE zmeniť.
  assert.equal((await db.query(`select title from public.tasks where id=$1`, [TASK])).rows[0].title, 'Tajná úloha', 'úloha ostala nezmenená');

  await mustRaise('delete cudzej úlohy outsiderom je zablokovaný', `select public.api_delete_task($1,gen_random_uuid())`, [TASK]);

  // 2) Najtvrdší scenár: úloha je priradená outsiderovi (mimo páru). Assignee-gate by
  //    sám neochránil – ochrániť musí pair-guard.
  await db.exec(`select set_config('app.user_id','${IVAN}',false);`);
  await db.query(`update public.tasks set assigned_to='${OUT}' where id=$1`, [TASK]);
  await db.exec(`select set_config('app.user_id','${OUT}',false);`);

  await mustRaise('complete outsiderom-priradencom je zablokovaný', `select public.api_complete_task($1,gen_random_uuid())`, [TASK]);
  await mustRaise('snooze outsiderom-priradencom je zablokovaný', `select public.api_snooze_task($1,15,gen_random_uuid())`, [TASK]);
  await mustRaise('acknowledge outsiderom-priradencom je zablokovaný', `select public.api_acknowledge_task($1,gen_random_uuid())`, [TASK]);
  await mustRaise('reject outsiderom-priradencom je zablokovaný', `select public.api_reject_task($1,'nechcem',gen_random_uuid())`, [TASK]);

  // Úloha musí stále byť pending (žiadna operácia neprešla).
  assert.equal((await db.query(`select status from public.tasks where id=$1`, [TASK])).rows[0].status, 'pending', 'žiadna outsider operácia úlohu nezmenila');

  // 3) Kontrola: legitímny člen páru (priradenec) operáciu vykonať SMIE.
  await db.exec(`select set_config('app.user_id','${IVAN}',false);`);
  await db.query(`update public.tasks set assigned_to='${DOMI}' where id=$1`, [TASK]);
  await db.exec(`select set_config('app.user_id','${DOMI}',false);`);
  await db.query(`select public.api_complete_task($1,gen_random_uuid())`, [TASK]);
  assert.equal((await db.query(`select status from public.tasks where id=$1`, [TASK])).rows[0].status, 'completed', 'legitímny člen páru úlohu dokončí');

  console.log('NULL-PAIR GUARD OK');
} finally { await db.close(); }

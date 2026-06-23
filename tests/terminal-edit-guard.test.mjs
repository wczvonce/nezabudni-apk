import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Issue 3: terminálne úlohy sa nesmú editovať na backend (nedá sa obísť klientom).
const db = new PGlite();
const IVAN = '11111111-1111-4111-8111-111111111111';
const DOMI = '22222222-2222-4222-8222-222222222222';
const PAIR = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';

const upd = (ver) =>
  `select public.api_update_task('${TASK}', gen_random_uuid(), ${ver}, '${IVAN}', 'Nove', null, now()+interval '2 hour', 'Europe/Bratislava', 1, 0, 'none', 'after', false, 60, 10)`;

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
  await db.exec(await readFile('supabase/migrations/006_terminal_edit_guard.sql', 'utf8'));
  await db.exec(`
    insert into auth.users values ('${IVAN}','i@e.com'),('${DOMI}','d@e.com');
    insert into public.profiles(id,display_name,email) values ('${IVAN}','Ivan','i@e.com'),('${DOMI}','Dominika','d@e.com');
    insert into public.pairs(id,name) values ('${PAIR}','I+D');
    insert into public.pair_members(pair_id,user_id,role) values ('${PAIR}','${IVAN}','owner'),('${PAIR}','${DOMI}','member');
    select set_config('app.user_id','${IVAN}',false);
  `);
  await db.query(`select public.api_create_task($1, gen_random_uuid(), $2, 'T', null, now()+interval '1 hour', 'Europe/Bratislava', 1, 0, 'none', 'after', false, 60, 10)`, [TASK, IVAN]);

  // Pending úlohu možno editovať (verzia 1).
  await db.query(upd(1));
  let v = (await db.query(`select status, version from public.tasks where id=$1`, [TASK])).rows[0];
  assert.equal(v.status, 'pending');

  // Splň úlohu → terminálny stav.
  await db.query(`select public.api_complete_task($1, gen_random_uuid())`, [TASK]);
  v = (await db.query(`select status, version from public.tasks where id=$1`, [TASK])).rows[0];
  assert.equal(v.status, 'completed', 'úloha je completed');

  // Edit terminálnej úlohy MUSÍ zlyhať (TASK_NOT_EDITABLE), nech klient pošle čokoľvek.
  await assert.rejects(db.query(upd(v.version)), /TASK_NOT_EDITABLE/, 'editovanie completed úlohy je odmietnuté');

  // UI guard: terminálna úloha je len na čítanie + poistka pri ukladaní.
  const ui = await readFile('src/ui/app-ui.js', 'utf8');
  assert.match(ui, /terminal = Boolean\(task\) && task\.status !== 'pending'/, 'UI rozpozná terminálnu úlohu');
  assert.match(ui, /editing && editing\.status !== 'pending'/, 'UI poistka proti uloženiu terminálnej úlohy');

  console.log('terminal-edit-guard.test: OK');
} catch (e) {
  console.error('terminal-edit-guard.test FAILED');
  console.error(e);
  process.exit(1);
} finally {
  await db.close();
}

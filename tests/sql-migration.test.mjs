import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const db = new PGlite();
const prelude = `
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
`;
try {
  await db.exec(prelude);
  let sql = await readFile('supabase/migrations/001_schema.sql','utf8');
  sql = sql.replace(/create extension if not exists pgcrypto;\s*/i, '');
  await db.exec(sql);
  const patch = await readFile('supabase/migrations/004_deep_audit_fixes.sql','utf8');
  await db.exec(patch);
  await db.exec(await readFile('supabase/migrations/005_offline_absolute_times.sql','utf8'));
  await db.exec(await readFile('supabase/migrations/006_terminal_edit_guard.sql','utf8'));
  console.log('SQL MIGRATION OK');
  const funcs = await db.query(`select proname, oidvectortypes(proargtypes) args from pg_proc join pg_namespace n on n.oid=pronamespace where n.nspname='public' order by proname`);
  console.log(funcs.rows.filter(r=>r.proname.startsWith('api_')||r.proname.includes('notification')).map(r=>r.proname+'('+r.args+')').join('\n'));
} catch (e) {
  console.error('SQL MIGRATION FAILED');
  console.error(e);
  process.exit(1);
} finally { await db.close(); }

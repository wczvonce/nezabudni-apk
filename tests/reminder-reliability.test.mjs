// 017: séria „v každom termíne" sa dá zastaviť z aktuálneho výskytu a pripomienky
// čakajúce na zariadenie sa po opätovnej registrácii hneď obnovia.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = new PGlite();
const IVAN = '11111111-1111-4111-8111-111111111111';
const DOMI = '22222222-2222-4222-8222-222222222222';
const PAIR = '33333333-3333-4333-8333-333333333333';
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await rows(sql, params))[0];

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users(id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.user_id',true),'')::uuid $$;
  create schema storage;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text);
  create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name,'/') $$;
  -- Supabase pridáva anon/authenticated EXECUTE na každú novú funkciu cez default privileges.
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`);
for (const name of ['001_schema', '004_deep_audit_fixes', '005_offline_absolute_times', '006_terminal_edit_guard', '007_reject_and_hide', '008_fix_null_pair_guard', '009_bug_hunt_2', '010_low_priority_fixes', '011_backend_capabilities']) {
  let sql = await readFile(`supabase/migrations/${name}.sql`, 'utf8');
  sql = sql.replace(/create extension if not exists pgcrypto;\s*/i, '');
  await db.exec(sql);
}
await db.exec(await readFile('supabase/migrations/017_reminder_reliability.sql', 'utf8'));
await db.exec(`
  insert into auth.users values ('${IVAN}','i@example.com'),('${DOMI}','d@example.com');
  insert into public.profiles(id,display_name,email) values ('${IVAN}','Ivan','i@example.com'),('${DOMI}','Dominika','d@example.com');
  insert into public.pairs(id,name) values ('${PAIR}','I+D');
  insert into public.pair_members(pair_id,user_id,role) values ('${PAIR}','${IVAN}','owner'),('${PAIR}','${DOMI}','member');
  select set_config('app.user_id','${IVAN}',false);
`);

const resetTasks = () => db.exec(`delete from public.notification_jobs; delete from public.task_events; delete from public.client_mutations; delete from public.tasks;`);

// Vytvorí týždennú sériu „v každom termíne" (1. výskyt pred 10 min) a nechá server
// vygenerovať 2. výskyt. Vráti { first, second }.
async function weeklyEachSeries({ completeFirst = false } = {}) {
  await resetTasks();
  const first = (await one(`select (public.api_create_task(gen_random_uuid(),gen_random_uuid(),$1,'Lieky','',now()-interval '10 minutes','Europe/Bratislava',1,0,'weekly','each',false,60,10)).id`, [IVAN])).id;
  if (completeFirst) await db.query(`select public.api_complete_task($1,gen_random_uuid())`, [first]);
  await db.query(`select public.api_generate_recurring_occurrences()`);
  const all = await rows(`select id from public.tasks order by occurrence_at`);
  assert.equal(all.length, 2, 'server mal vygenerovať presne 1 ďalší výskyt');
  return { first, second: all[1].id };
}
// Posunie celú sériu o 8 dní do minulosti (simulácia, že termín 2. výskytu uplynul) a spustí generátor.
async function timePassesAndGenerate() {
  await db.exec(`update public.tasks set occurrence_at=occurrence_at-interval '8 days', due_at=due_at-interval '8 days'`);
  await db.query(`select public.api_generate_recurring_occurrences()`);
}
const futureWeeklyPending = async () => (await one(`select count(*)::int c from public.tasks where deleted_at is null and status='pending' and recurrence_rule='weekly' and occurrence_at>now()`)).c;

// Kontrola: nedotknutá séria pokračuje.
await weeklyEachSeries();
await timePassesAndGenerate();
assert.equal(await futureWeeklyPending(), 1, 'nedotknutá séria musí pokračovať ďalším výskytom');

for (const completeFirst of [false, true]) {
  // Vypnutie opakovania na aktuálnom výskyte sériu ukončí.
  let { second } = await weeklyEachSeries({ completeFirst });
  const v = (await one(`select version from public.tasks where id=$1`, [second])).version;
  await db.query(`select public.api_update_task($1,gen_random_uuid(),$2,$3,'Lieky','',now()+interval '7 days','Europe/Bratislava',1,0,'none','after',false,60,10)`, [second, v, IVAN]);
  await timePassesAndGenerate();
  assert.equal(await futureWeeklyPending(), 0, `vypnuté opakovanie nesmie sériu oživiť (prvý splnený=${completeFirst})`);

  // Vymazanie aktuálneho výskytu sériu ukončí.
  ({ second } = await weeklyEachSeries({ completeFirst }));
  await db.query(`select public.api_delete_task($1,gen_random_uuid())`, [second]);
  await timePassesAndGenerate();
  assert.equal(await futureWeeklyPending(), 0, `zmazaný výskyt nesmie sériu oživiť (prvý splnený=${completeFirst})`);
}

// Prepnutie aktuálneho výskytu na „až po splnení" generovanie v každom termíne zastaví.
{
  const { second } = await weeklyEachSeries();
  const v = (await one(`select version from public.tasks where id=$1`, [second])).version;
  await db.query(`select public.api_update_task($1,gen_random_uuid(),$2,$3,'Lieky','',now()+interval '7 days','Europe/Bratislava',1,0,'weekly','after',false,60,10)`, [second, v, IVAN]);
  await timePassesAndGenerate();
  assert.equal((await one(`select count(*)::int c from public.tasks where occurrence_at>now()`)).c, 0, 'režim „po splnení" negeneruje výskyty v termíne');
}

// ── Pripomienky čakajúce na zariadenie ───────────────────────────────────────
await resetTasks();
const task = (await one(`select (public.api_create_task(gen_random_uuid(),gen_random_uuid(),$1,'Zavolať','',now()-interval '30 seconds','Europe/Bratislava',1,0,'none','after',false,60,10)).id`, [IVAN])).id;
const due = await one(`select id from public.notification_jobs where task_id=$1 and kind='task_due' and status='queued'`, [task]);
assert.ok(due, 'task_due job musí existovať');
await db.query(`update public.notification_jobs set status='processing',attempt_count=1,locked_at=now() where id=$1`, [due.id]);
await db.query(`select public.mark_notification_failed($1,'NO_ACTIVE_SUBSCRIPTIONS')`, [due.id]);
let job = await one(`select status, extract(epoch from scheduled_at-now())::int wait from public.notification_jobs where id=$1`, [due.id]);
assert.equal(job.status, 'queued');
assert.ok(job.wait > 60 && job.wait <= 120, `pripomienka bez zariadenia sa má skúsiť do 2 min (bolo ${job.wait}s)`);

// Informačná správa (task_assigned) bez zariadenia si ponecháva 15-minútový retry.
const info = (await one(`insert into public.notification_jobs(task_id,recipient_id,kind,scheduled_at,status,attempt_count,locked_at,dedupe_key) values($1,$2,'task_assigned',now(),'processing',1,now(),'t-info-017') returning id`, [task, IVAN])).id;
await db.query(`select public.mark_notification_failed($1,'NO_ACTIVE_SUBSCRIPTIONS')`, [info]);
const infoWait = (await one(`select extract(epoch from scheduled_at-now())::int wait from public.notification_jobs where id=$1`, [info])).wait;
assert.ok(infoWait > 800, `informačná správa ostáva na 15 min retry (bolo ${infoWait}s)`);

// Opätovná registrácia zariadenia pošle čakajúcu pripomienku hneď.
await db.query(`select public.api_register_device('sub-ivan-017-abcdef','android','eeeeeeee-0170-4eee-8eee-eeeeeeeeeeee','Ivan Android')`);
job = await one(`select status, scheduled_at<=now() ready from public.notification_jobs where id=$1`, [due.id]);
assert.equal(job.status, 'queued');
assert.equal(job.ready, true, 'po registrácii zariadenia sa čakajúca pripomienka musí poslať hneď');

// Cudzia pripomienka (iný príjemca) sa registráciou Ivana nehýbe.
await db.exec(`select set_config('app.user_id','${DOMI}',false);`);
const domiTask = (await one(`select (public.api_create_task(gen_random_uuid(),gen_random_uuid(),$1,'Domi','',now()-interval '30 seconds','Europe/Bratislava',1,0,'none','after',false,60,10)).id`, [DOMI])).id;
const domiDue = await one(`select id from public.notification_jobs where task_id=$1 and kind='task_due'`, [domiTask]);
await db.query(`update public.notification_jobs set status='processing',attempt_count=1,locked_at=now() where id=$1`, [domiDue.id]);
await db.query(`select public.mark_notification_failed($1,'NO_ACTIVE_SUBSCRIPTIONS')`, [domiDue.id]);
await db.exec(`select set_config('app.user_id','${IVAN}',false);`);
await db.query(`select public.api_register_device('sub-ivan-017-abcdef','android','eeeeeeee-0170-4eee-8eee-eeeeeeeeeeee','Ivan Android')`);
assert.equal((await one(`select scheduled_at>now() waiting from public.notification_jobs where id=$1`, [domiDue.id])).waiting, true, 'registrácia nesmie posunúť pripomienky iného používateľa');

// ── anon nesmie volať SECURITY DEFINER RPC ───────────────────────────────────
const anonExec = await rows(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') order by 1`);
assert.deepEqual(anonExec.map((r) => r.proname), [], `anon nesmie mať EXECUTE na SECURITY DEFINER funkciách: ${anonExec.map((r) => r.proname).join(', ')}`);
assert.equal((await one(`select (public.get_backend_capabilities()->>'schema_version')::int v`)).v, 17);

console.log('REMINDER RELIABILITY (017): each-séria sa dá zastaviť, pripomienky sa po registrácii obnovia, anon bez EXECUTE — OK');

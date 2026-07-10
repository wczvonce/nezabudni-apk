// Bug-hunt kolo 2 (2026-07) – regresné testy migrácie 009.
// 1) Odmietnutú úlohu nemožno dokončiť (terminálny guard v api_complete_task).
// 2) Jedna "otrávená" séria nezastaví generovanie opakovaní ostatných sérií.
// 3) Dokončenie 'after' úlohy prežije zlyhanie plánovania ďalšieho výskytu.
// 4) next_occurrence: denná úloha o 02:30 sa po jarnom DST skoku vráti na 02:30.
// 5) mutation_is_duplicate: idempotentné a race-safe (insert on conflict).
// 6) Kolízia occurrence_at pri edite koreňa série -> TASK_CONFLICT, nie 23505.
// 7) Stale-recovery v claim_notification_jobs rešpektuje limit pokusov.
// 8) requeue_unfinished_jobs vráti job do fronty bez spálenia attempt_count.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = new PGlite();
const IVAN = '11111111-1111-4111-8111-111111111111';
const DOMI = '22222222-2222-4222-8222-222222222222';
const PAIR = '33333333-3333-4333-8333-333333333333';

async function raisedMessage(sql, params = []) {
  try { await db.query(sql, params); return null; } catch (error) { return String(error?.message || error); }
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
  for (const m of ['004_deep_audit_fixes', '005_offline_absolute_times', '006_terminal_edit_guard', '007_reject_and_hide', '008_fix_null_pair_guard', '009_bug_hunt_2', '010_low_priority_fixes', '011_backend_capabilities']) {
    await db.exec(await readFile(`supabase/migrations/${m}.sql`, 'utf8'));
  }

  await db.exec(`
    insert into auth.users values ('${IVAN}','i@x.sk'),('${DOMI}','d@x.sk');
    insert into public.profiles(id,display_name,email) values ('${IVAN}','Ivan','i@x.sk'),('${DOMI}','Dominika','d@x.sk');
    insert into public.pairs(id,name) values ('${PAIR}','I+D');
    insert into public.pair_members(pair_id,user_id,role) values ('${PAIR}','${IVAN}','owner'),('${PAIR}','${DOMI}','member');
    select set_config('app.user_id','${IVAN}',false);
  `);

  // ── 1) Rejected -> complete musí zlyhať TASK_NOT_EDITABLE ────────────────
  const T1 = '44444444-4444-4444-8444-444444444401';
  const due = new Date(Date.now() + 3600_000).toISOString();
  await db.query(`select public.api_create_task($1,gen_random_uuid(),$2,'Na odmietnutie','',$3,'Europe/Bratislava',1,0,'none','after',false,60,5)`, [T1, DOMI, due]);
  await db.exec(`select set_config('app.user_id','${DOMI}',false);`);
  await db.query(`select public.api_reject_task($1,'nechcem',gen_random_uuid())`, [T1]);
  const rejectedCompleteError = await raisedMessage(`select public.api_complete_task($1,gen_random_uuid())`, [T1]);
  assert.ok(rejectedCompleteError?.includes('TASK_NOT_EDITABLE'), `rejected complete musí zlyhať TASK_NOT_EDITABLE, dostal: ${rejectedCompleteError}`);
  const t1 = (await db.query(`select status, rejection_reason from public.tasks where id=$1`, [T1])).rows[0];
  assert.equal(t1.status, 'rejected', 'odmietnutá úloha ostáva odmietnutá');
  assert.equal((await db.query(`select count(*)::int c from public.tasks where series_id=$1`, [T1])).rows[0].c, 1, 'z odmietnutej after-série sa nespawnol nový výskyt');

  // ── 2) Otrávená séria nezastaví generovanie ostatných ────────────────────
  await db.exec(`select set_config('app.user_id','${IVAN}',false);`);
  const POISON = '44444444-4444-4444-8444-444444444402';
  const HEALTHY = '44444444-4444-4444-8444-444444444403';
  // >1000 zameškaných denných periód -> create_next_recurring_task hodí RECURRENCE_GUARD_EXCEEDED.
  await db.query(`insert into public.tasks(id,pair_id,created_by,assigned_to,title,due_at,timezone,recurrence_rule,recurrence_mode,series_id,occurrence_at,last_changed_by)
    values ($1,$2,$3,$4,'Otrávená séria',now()-interval '1100 days','Europe/Bratislava','daily','each',$1,now()-interval '1100 days',$3)`, [POISON, PAIR, IVAN, DOMI]);
  await db.query(`insert into public.tasks(id,pair_id,created_by,assigned_to,title,due_at,timezone,recurrence_rule,recurrence_mode,series_id,occurrence_at,last_changed_by)
    values ($1,$2,$3,$4,'Zdravá séria',now()-interval '1 hour','Europe/Bratislava','daily','each',$1,now()-interval '1 hour',$3)`, [HEALTHY, PAIR, IVAN, DOMI]);
  const generated = (await db.query(`select public.api_generate_recurring_occurrences() n`)).rows[0].n;
  assert.ok(generated >= 1, `zdravá séria sa musí vygenerovať aj popri otrávenej (generated=${generated})`);
  assert.equal((await db.query(`select count(*)::int c from public.tasks where series_id=$1`, [HEALTHY])).rows[0].c, 2, 'zdravá séria má nový výskyt');
  assert.equal((await db.query(`select count(*)::int c from public.tasks where series_id=$1`, [POISON])).rows[0].c, 1, 'otrávená séria sa preskočila bez pádu');

  // ── 3) Complete 'after' úlohy prežije zlyhanie plánovania výskytu ─────────
  const STALE_AFTER = '44444444-4444-4444-8444-444444444404';
  await db.query(`insert into public.tasks(id,pair_id,created_by,assigned_to,title,due_at,timezone,recurrence_rule,recurrence_mode,series_id,occurrence_at,last_changed_by)
    values ($1,$2,$3,$4,'Stará after úloha',now()-interval '1100 days','Europe/Bratislava','daily','after',$1,now()-interval '1100 days',$3)`, [STALE_AFTER, PAIR, IVAN, DOMI]);
  await db.exec(`select set_config('app.user_id','${DOMI}',false);`);
  await db.query(`select public.api_complete_task($1,gen_random_uuid())`, [STALE_AFTER]);
  assert.equal((await db.query(`select status from public.tasks where id=$1`, [STALE_AFTER])).rows[0].status, 'completed', 'dokončenie prežije RECURRENCE_GUARD_EXCEEDED');

  // ── 4) DST: denná 02:30 sa po jarnom skoku vráti na 02:30 ────────────────
  // 2026-03-29 o 02:00 Europe/Bratislava preskakuje na 03:00 (02:30 neexistuje).
  const dstRows = await db.query(`
    with anchor as (select ('2026-03-28 02:30'::timestamp) at time zone 'Europe/Bratislava' a),
    n1 as (select public.next_occurrence(a,'daily','Europe/Bratislava',a) v from anchor),
    n2 as (select public.next_occurrence(n1.v,'daily','Europe/Bratislava',(select a from anchor)) v from n1)
    select to_char(n1.v at time zone 'Europe/Bratislava','HH24:MI') d1, to_char(n2.v at time zone 'Europe/Bratislava','HH24:MI') d2 from n1, n2
  `);
  assert.equal(dstRows.rows[0].d2, '02:30', `deň po DST skoku sa výskyt vracia na 02:30 (dostal ${dstRows.rows[0].d2}; deň skoku: ${dstRows.rows[0].d1})`);

  // ── 5) mutation_is_duplicate: idempotencia + ochrana pred reuse ───────────
  const MUT = '55555555-5555-4555-8555-555555555501';
  assert.equal((await db.query(`select public.mutation_is_duplicate($1,'complete',$2) d`, [MUT, T1])).rows[0].d, false, 'prvé volanie nie je duplikát');
  assert.equal((await db.query(`select public.mutation_is_duplicate($1,'complete',$2) d`, [MUT, T1])).rows[0].d, true, 'opakované volanie je duplikát');
  const reuseError = await raisedMessage(`select public.mutation_is_duplicate($1,'delete',$2)`, [MUT, T1]);
  assert.ok(reuseError?.includes('MUTATION_ID_REUSE'), 'iná operácia s tým istým mutation_id musí zlyhať');

  // ── 6) Kolízia occurrence_at pri edite koreňa -> TASK_CONFLICT ────────────
  await db.exec(`select set_config('app.user_id','${IVAN}',false);`);
  const ROOT = '44444444-4444-4444-8444-444444444405';
  const CHILD = '44444444-4444-4444-8444-444444444406';
  const rootDue = new Date(Date.now() + 24 * 3600_000).toISOString();
  const childDue = new Date(Date.now() + 48 * 3600_000).toISOString();
  await db.query(`select public.api_create_task($1,gen_random_uuid(),$2,'Koreň série','',$3,'Europe/Bratislava',1,0,'daily','each',false,60,5)`, [ROOT, DOMI, rootDue]);
  await db.query(`insert into public.tasks(id,pair_id,created_by,assigned_to,title,due_at,timezone,recurrence_rule,recurrence_mode,series_id,occurrence_at,last_changed_by)
    values ($1,$2,$3,$4,'Vygenerovaný výskyt',$5,'Europe/Bratislava','daily','each',$6,$5,$3)`, [CHILD, PAIR, IVAN, DOMI, childDue, ROOT]);
  const rootVersion = (await db.query(`select version from public.tasks where id=$1`, [ROOT])).rows[0].version;
  const collisionError = await raisedMessage(
    `select public.api_update_task($1,gen_random_uuid(),$2,$3,'Koreň série','',$4,'Europe/Bratislava',1,0,'daily','each',false,60,5)`,
    [ROOT, rootVersion, DOMI, childDue],
  );
  assert.ok(collisionError?.includes('TASK_CONFLICT'), `kolízia occurrence_at musí byť TASK_CONFLICT, dostal: ${collisionError}`);
  assert.ok(!collisionError?.includes('duplicate key'), 'surová 23505 nesmie presiaknuť ku klientovi');

  // ── 7) Stale-recovery rešpektuje limit pokusov ────────────────────────────
  const JOB_EXHAUSTED = '66666666-6666-4666-8666-666666666601';
  const JOB_FRESH = '66666666-6666-4666-8666-666666666602';
  await db.query(`insert into public.notification_jobs(id,recipient_id,kind,scheduled_at,status,dedupe_key,attempt_count,locked_at)
    values ($1,$2,'test',now()+interval '1 hour','processing','bh2-exhausted',5,now()-interval '20 minutes'),
           ($3,$2,'test',now()+interval '1 hour','processing','bh2-fresh',1,now()-interval '20 minutes')`, [JOB_EXHAUSTED, IVAN, JOB_FRESH]);
  await db.query(`select * from public.claim_notification_jobs(5)`);
  assert.equal((await db.query(`select status from public.notification_jobs where id=$1`, [JOB_EXHAUSTED])).rows[0].status, 'failed', 'job s vyčerpanými pokusmi sa po stale-recovery neredoručuje');
  assert.equal((await db.query(`select status from public.notification_jobs where id=$1`, [JOB_FRESH])).rows[0].status, 'queued', 'job s voľnými pokusmi sa vráti do fronty');

  // ── 8) requeue_unfinished_jobs nespaľuje attempt_count ────────────────────
  const JOB_REQUEUE = '66666666-6666-4666-8666-666666666603';
  const JOB_SENT = '66666666-6666-4666-8666-666666666604';
  await db.query(`insert into public.notification_jobs(id,recipient_id,kind,scheduled_at,status,dedupe_key,attempt_count,locked_at)
    values ($1,$2,'test',now(),'processing','bh2-requeue',2,now()),
           ($3,$2,'test',now(),'sent','bh2-sent',2,null)`, [JOB_REQUEUE, IVAN, JOB_SENT]);
  await db.query(`select public.requeue_unfinished_jobs(array[$1,$2]::uuid[])`, [JOB_REQUEUE, JOB_SENT]);
  const requeued = (await db.query(`select status, attempt_count from public.notification_jobs where id=$1`, [JOB_REQUEUE])).rows[0];
  assert.equal(requeued.status, 'queued', 'nedokončený job sa vráti do fronty');
  assert.equal(requeued.attempt_count, 1, 'attempt_count z claimu sa pri requeue vráti späť');
  assert.equal((await db.query(`select status from public.notification_jobs where id=$1`, [JOB_SENT])).rows[0].status, 'sent', 'odoslaný job ostáva nedotknutý');

  console.log('BUG-HUNT-2 OK');
} finally { await db.close(); }

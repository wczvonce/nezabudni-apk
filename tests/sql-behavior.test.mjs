import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = new PGlite();
const IVAN='11111111-1111-4111-8111-111111111111';
const DOMI='22222222-2222-4222-8222-222222222222';
const PAIR='33333333-3333-4333-8333-333333333333';
const TASK='44444444-4444-4444-8444-444444444444';
const M1='55555555-5555-4555-8555-555555555551';
const M2='55555555-5555-4555-8555-555555555552';
const M3='55555555-5555-4555-8555-555555555553';
const M4='55555555-5555-4555-8555-555555555554';
const M5='55555555-5555-4555-8555-555555555555';
const ASSIGN_TASK='aaaaaaaa-1111-4111-8111-111111111111';
const RACE_TASK='aaaaaaaa-2222-4222-8222-222222222222';

async function scalar(sql, params=[]){ const r=await db.query(sql,params); return r.rows[0]; }
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
  let sql=await readFile('supabase/migrations/001_schema.sql','utf8');
  sql=sql.replace(/create extension if not exists pgcrypto;\s*/i,'');
  await db.exec(sql);
  await db.exec(`
    insert into auth.users values ('${IVAN}','i@example.com'),('${DOMI}','d@example.com');
    insert into public.profiles(id,display_name,email) values ('${IVAN}','Ivan','i@example.com'),('${DOMI}','Dominika','d@example.com');
    insert into public.pairs(id,name) values ('${PAIR}','I+D');
    insert into public.pair_members(pair_id,user_id,role) values ('${PAIR}','${IVAN}','owner'),('${PAIR}','${DOMI}','member');
    select set_config('app.user_id','${IVAN}',false);
  `);
  const due1=new Date(Date.now()-1_000).toISOString();
  const due2=new Date(Date.now()+7200_000).toISOString();
  await db.query(`select (public.api_create_task($1,$2,$3,$4,$5,$6,'Europe/Bratislava',1,0,'none','after',true,60,10)).id`,[TASK,M1,DOMI,'Test','Pozn',due1]);
  let jobs=await db.query(`select kind,status,recipient_id,dedupe_key from public.notification_jobs where task_id=$1 order by kind`,[TASK]);
  assert.equal(jobs.rows.filter(x=>x.kind==='task_assigned'&&x.status==='queued').length,1,'assignment job must remain queued');
  assert.equal(jobs.rows.filter(x=>x.kind==='task_due'&&x.status==='queued').length,1,'due job missing');
  // Same mutation is idempotent.
  await db.query(`select (public.api_create_task($1,$2,$3,$4,$5,$6,'Europe/Bratislava',1,0,'none','after',true,60,10)).id`,[TASK,M1,DOMI,'Test','Pozn',due1]);
  assert.equal((await scalar(`select count(*)::int c from public.tasks where id=$1`,[TASK])).c,1);
  let invalidTimezoneBlocked=false;
  try {
    await db.query(`select public.api_create_task(gen_random_uuid(),gen_random_uuid(),$1,'Bad TZ','',now(),'Not/A_Timezone',1,0,'none','after',false,60,1)`,[IVAN]);
  } catch { invalidTimezoneBlocked=true; }
  assert.equal(invalidTimezoneBlocked,true,'Invalid timezone must be rejected at write time');
  // Move due time away and back; versioned dedupe keys must allow a fresh active job.
  await db.query(`select public.api_update_task($1,$2,1,$3,$4,$5,$6,'Europe/Bratislava',1,0,'none','after',true,60,10)`,[TASK,M2,DOMI,'Test','Pozn',due2]);
  await db.query(`select public.api_update_task($1,$2,2,$3,$4,$5,$6,'Europe/Bratislava',1,0,'none','after',true,60,10)`,[TASK,M3,DOMI,'Test','Pozn',due1]);
  assert.equal((await scalar(`select count(*)::int c from public.notification_jobs where task_id=$1 and kind='task_due' and status='queued'`,[TASK])).c,1,'exactly one active due job expected');
  // Mark due sent, ensure repeat. Then snooze and repeat cycle must be recreated with a new version.
  const dueJob=(await db.query(`select id from public.notification_jobs where task_id=$1 and kind='task_due' and status='queued' limit 1`,[TASK])).rows[0];
  await db.query(`update public.notification_jobs set status='processing' where id=$1`,[dueJob.id]);
  await db.query(`select public.mark_notification_sent($1,'msg-1')`,[dueJob.id]);
  assert.equal((await scalar(`select count(*)::int c from public.notification_jobs where task_id=$1 and kind='task_repeat' and status='queued'`,[TASK])).c,1);
  const remindersAfterFirstSend=(await scalar(`select reminders_sent from public.tasks where id=$1`,[TASK])).reminders_sent;
  // Starý worker nesmie po úspechu job znovu označiť ako failed ani zvýšiť počítadlo druhýkrát.
  await db.query(`select public.mark_notification_failed($1,'late timeout')`,[dueJob.id]);
  await db.query(`select public.mark_notification_sent($1,'msg-duplicate')`,[dueJob.id]);
  assert.equal((await scalar(`select status from public.notification_jobs where id=$1`,[dueJob.id])).status,'sent');
  assert.equal((await scalar(`select reminders_sent from public.tasks where id=$1`,[TASK])).reminders_sent,remindersAfterFirstSend);
  // Pri priradení úlohy samému sebe nesmie vzniknúť zavádzajúca správa „od partnera“.
  await db.exec(`select set_config('app.user_id','${IVAN}',false);`);
  await db.query(`select public.api_create_task($1,gen_random_uuid(),$2,'Reassign test','',$3,'Europe/Bratislava',1,0,'none','after',false,60,3)`,[ASSIGN_TASK,DOMI,due2]);
  await db.query(`select public.api_update_task($1,gen_random_uuid(),1,$2,'Reassign test','',$3,'Europe/Bratislava',1,0,'none','after',false,60,3)`,[ASSIGN_TASK,IVAN,due2]);
  assert.equal((await scalar(`select count(*)::int c from public.notification_jobs where task_id=$1 and kind='task_assigned' and status='queued'`,[ASSIGN_TASK])).c,0,'self-assignment must not create partner notification');

  await db.exec(`select set_config('app.user_id','${DOMI}',false);`);
  await db.query(`select public.api_snooze_task($1,15,$2)`,[TASK,M4]);
  const snoozedDue=(await db.query(`select id from public.notification_jobs where task_id=$1 and kind='task_due' and status='queued' order by created_at desc limit 1`,[TASK])).rows[0];
  assert.ok(snoozedDue,'snoozed due job missing');
  // Posuň testovací čas úlohy do minulosti, aby worker simuloval reálny okamih po snooze.
  await db.query(`update public.tasks set snoozed_until=now()-interval '1 second' where id=$1`,[TASK]);
  await db.query(`update public.notification_jobs set status='processing' where id=$1`,[snoozedDue.id]);
  await db.query(`select public.mark_notification_sent($1,'msg-2')`,[snoozedDue.id]);
  assert.equal((await scalar(`select count(*)::int c from public.notification_jobs where task_id=$1 and kind='task_repeat' and status='queued'`,[TASK])).c,1,'new repeat cycle missing after snooze');
  // Completion should notify creator exactly once.
  await db.query(`select public.api_complete_task($1,$2)`,[TASK,M5]);
  await db.query(`select public.api_complete_task($1,$2)`,[TASK,M5]);
  assert.equal((await scalar(`select count(*)::int c from public.notification_jobs where task_id=$1 and kind='task_completed'`,[TASK])).c,1);


  // Aktívna subscription nesmie byť ukradnutá druhým účtom; po korektnom odhlásení sa môže bezpečne preniesť.
  let invalidSubscriptionBlocked=false;
  try { await db.query(`select public.api_register_device('x','android',$1,'bad')`,['77777777-7777-4777-8777-777777777777']); } catch { invalidSubscriptionBlocked=true; }
  assert.equal(invalidSubscriptionBlocked,true,'Invalid subscription id must be rejected');
  const SUB='sub-test-1';
  const INSTALL='77777777-7777-4777-8777-777777777777';
  await db.exec(`select set_config('app.user_id','${IVAN}',false);`);
  await db.query(`select public.api_register_device($1,'android',$2,'Ivan Android')`,[SUB,INSTALL]);
  await db.exec(`select set_config('app.user_id','${DOMI}',false);`);
  let transferBlocked=false;
  try { await db.query(`select public.api_register_device($1,'ios',$2,'Dominika iPhone')`,[SUB,INSTALL]); } catch { transferBlocked=true; }
  assert.equal(transferBlocked,true,'Aktívnu subscription nesmie prevziať iný účet');
  await db.exec(`select set_config('app.user_id','${IVAN}',false);`);
  await db.query(`select public.api_unregister_device($1)`,[SUB]);
  await db.exec(`select set_config('app.user_id','${DOMI}',false);`);
  await db.query(`select public.api_register_device($1,'ios',$2,'Dominika iPhone')`,[SUB,INSTALL]);
  const owner=await scalar(`select user_id,active from public.device_subscriptions where subscription_id=$1`,[SUB]);
  assert.equal(owner.user_id,DOMI);
  assert.equal(owner.active,true);

  // Nová subscription smie znovu zaradiť informačné správy, nie staré alarmy.
  await db.exec(`select set_config('app.user_id','${IVAN}',false);`);
  const FAILED_DUE='abababab-abab-4bab-8bab-abababababab';
  const FAILED_ASSIGNED='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  await db.query(`insert into public.notification_jobs(id,task_id,recipient_id,kind,scheduled_at,status,dedupe_key,last_error) values
    ($1,$3,$4,'task_due',now()-interval '1 hour','failed','failed-due-test','NO_ACTIVE_SUBSCRIPTIONS'),
    ($2,$3,$4,'task_assigned',now()-interval '1 hour','failed','failed-assigned-test','NO_ACTIVE_SUBSCRIPTIONS')`,[FAILED_DUE,FAILED_ASSIGNED,ASSIGN_TASK,IVAN]);
  await db.query(`select public.api_register_device('sub-ivan-fresh-12345','android','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Ivan fresh')`);
  assert.equal((await scalar(`select status from public.notification_jobs where id=$1`,[FAILED_DUE])).status,'failed','stale due reminder must not be requeued');
  assert.equal((await scalar(`select status from public.notification_jobs where id=$1`,[FAILED_ASSIGNED])).status,'queued','assignment info should be requeued');

  // Testovacie notifikácie majú krátky rate limit, aby omyl alebo kompromitovaný klient nespamoval.
  await db.query(`select public.api_send_test_notification()`);
  let testRateBlocked=false;
  try { await db.query(`select public.api_send_test_notification()`); } catch { testRateBlocked=true; }
  assert.equal(testRateBlocked,true,'test notification rate limit must block immediate duplicate');

  // Opakovania musia zachovať lokálny čas cez zmenu letného času a mesačný anchor deň.
  const dst=await scalar(`select to_char(public.next_occurrence('2026-03-28 09:00:00+01'::timestamptz,'daily','Europe/Bratislava',null) at time zone 'Europe/Bratislava','YYYY-MM-DD HH24:MI') v`);
  assert.equal(dst.v,'2026-03-29 09:00');
  const feb=await scalar(`select public.next_occurrence('2026-01-31 09:00:00+01'::timestamptz,'monthly','Europe/Bratislava','2026-01-31 09:00:00+01'::timestamptz) v`);
  const mar=await scalar(`select to_char(public.next_occurrence($1::timestamptz,'monthly','Europe/Bratislava','2026-01-31 09:00:00+01'::timestamptz) at time zone 'Europe/Bratislava','YYYY-MM-DD HH24:MI') v`,[feb.v]);
  assert.equal(mar.v,'2026-03-31 09:00');


  // Režim „každý termín“ generuje iba jeden nasledujúci výskyt a potom sa zastaví, kým nenastane.
  const SERIES_TASK='88888888-8888-4888-8888-888888888888';
  const SERIES_MUT='99999999-9999-4999-8999-999999999999';
  await db.exec(`select set_config('app.user_id','${IVAN}',false);`);
  const past=new Date(Date.now()-3600_000).toISOString();
  await db.query(`select public.api_create_task($1,$2,$3,'Denná','',$4,'Europe/Bratislava',1,0,'daily','each',false,60,1)`,[SERIES_TASK,SERIES_MUT,IVAN,past]);
  const generated1=await scalar(`select public.api_generate_recurring_occurrences() c`);
  const generated2=await scalar(`select public.api_generate_recurring_occurrences() c`);
  assert.equal(generated1.c,1);
  assert.equal(generated2.c,0);
  const generatedOccurrence=await scalar(`select occurrence_at>now() future from public.tasks where series_id=$1 and id<>$1 order by occurrence_at desc limit 1`,[SERIES_TASK]);
  assert.equal(generatedOccurrence.future,true,'recurrence after downtime must skip to a future occurrence');

  // Starý job nesmie po zmene verzie poškodiť nový reminder cyklus.
  const racePast=new Date(Date.now()-120_000).toISOString();
  await db.query(`select public.api_create_task($1,gen_random_uuid(),$2,'Race reminder','',$3,'Europe/Bratislava',1,0,'none','after',false,60,5)`,[RACE_TASK,IVAN,racePast]);
  const raceJob=(await db.query(`select id from public.notification_jobs where task_id=$1 and kind='task_due' and status='queued' limit 1`,[RACE_TASK])).rows[0];
  await db.query(`update public.notification_jobs set status='processing' where id=$1`,[raceJob.id]);
  await db.query(`select public.api_snooze_task($1,15,gen_random_uuid())`,[RACE_TASK]);
  // Simuluj veľmi oneskorený callback starého workera.
  await db.query(`update public.notification_jobs set status='processing' where id=$1`,[raceJob.id]);
  await db.query(`select public.mark_notification_sent($1,'late-old-message')`,[raceJob.id]);
  assert.equal((await scalar(`select reminders_sent from public.tasks where id=$1`,[RACE_TASK])).reminders_sent,0,'old version must not increment current reminder counter');
  assert.equal((await scalar(`select count(*)::int c from public.notification_jobs where task_id=$1 and kind='task_repeat' and status='queued'`,[RACE_TASK])).c,0,'old version must not schedule a repeat');

  // Stale processing jobs recover.
  const testJob='66666666-6666-4666-8666-666666666666';
  await db.exec(`insert into public.notification_jobs(id,recipient_id,kind,scheduled_at,status,dedupe_key,locked_at) values ('${testJob}','${IVAN}','test',now()-interval '1 hour','processing','stale-test',now()-interval '20 minutes');`);
  const claimed=await db.query(`select id,status from public.claim_notification_jobs(25)`);
  assert.ok(claimed.rows.some(r=>r.id===testJob),'stale job was not recovered and claimed');
  console.log('SQL BEHAVIOR OK');
} finally { await db.close(); }

// 018: odpoveď na úlohu – pôvodná sa zavrie ako „Posunuté", nová úloha pre
// vybraného člena je prepojená do reťaze (genéza) a všetko je atomické.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = new PGlite();
const IVAN = '11111111-1111-4111-8111-111111111111';
const DOMI = '22222222-2222-4222-8222-222222222222';
const PAIR = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const OTHER_PAIR = '55555555-5555-4555-8555-555555555555';
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await rows(sql, params))[0];
const as = (user) => db.query(`select set_config('app.user_id',$1,false)`, [user]);
const newId = async () => (await one(`select gen_random_uuid()::text id`)).id;

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users(id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.user_id',true),'')::uuid $$;
  create schema storage;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text);
  create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name,'/') $$;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`);
for (const name of ['001_schema', '004_deep_audit_fixes', '005_offline_absolute_times', '006_terminal_edit_guard', '007_reject_and_hide', '008_fix_null_pair_guard', '009_bug_hunt_2', '010_low_priority_fixes', '011_backend_capabilities', '017_reminder_reliability', '018_task_handoff']) {
  let sql = await readFile(`supabase/migrations/${name}.sql`, 'utf8');
  sql = sql.replace(/create extension if not exists pgcrypto;\s*/i, '');
  await db.exec(sql);
}
await db.exec(`
  insert into auth.users values ('${IVAN}','i@example.com'),('${DOMI}','d@example.com'),('${OTHER}','o@example.com');
  insert into public.profiles(id,display_name,email) values ('${IVAN}','Ivan','i@example.com'),('${DOMI}','Ivka','d@example.com'),('${OTHER}','Cudzí','o@example.com');
  insert into public.pairs(id,name) values ('${PAIR}','I+I'),('${OTHER_PAIR}','Iná');
  insert into public.pair_members(pair_id,user_id,role) values ('${PAIR}','${IVAN}','owner'),('${PAIR}','${DOMI}','member'),('${OTHER_PAIR}','${OTHER}','owner');
`);

async function createTask(assignee, { rule = 'none', mode = 'after', due = `now()+interval '1 hour'` } = {}) {
  return (await one(`select (public.api_create_task(gen_random_uuid(),gen_random_uuid(),$1,'Zavolať opravára','číslo je v prílohe',${due},'Europe/Bratislava',2,0,$2,$3,false,60,10)).id`, [assignee, rule, mode])).id;
}
function handoff(taskId, { newTaskId, mutationId, to = IVAN, title = 'Zavolať majiteľovi', notes = 'Opravár chce súhlas majiteľa', rule = 'none' } = {}) {
  return db.query(`select public.api_handoff_task($1,$2,$3,$4,$5,$6,now()+interval '2 hours','Europe/Bratislava',2,0,$7,'after',true,60,10) as r`,
    [taskId, newTaskId, mutationId, to, title, notes, rule]).then((res) => res.rows[0].r);
}

// ── Základný tok: Ivan zadá Ivke, Ivka odpovie Ivanovi ─────────────────────────
await as(IVAN);
const first = await createTask(DOMI);
await as(DOMI);
const secondId = await newId();
const mutation = await newId();
const result = await handoff(first, { newTaskId: secondId, mutationId: mutation, notes: '  Opravár chce súhlas majiteľa  ' });
assert.equal(result.original.id, first);
assert.equal(result.original.status, 'handed_off');
assert.equal(result.original.handed_off_to, IVAN);
assert.ok(result.original.handed_off_at, 'pôvodná úloha nesie čas posunutia');
assert.equal(result.task.id, secondId);
assert.equal(result.task.status, 'pending');
assert.equal(result.task.created_by, DOMI);
assert.equal(result.task.assigned_to, IVAN);
assert.equal(result.task.parent_task_id, first);
assert.equal(result.task.thread_id, first, 'prvá odpoveď: reťaz začína pôvodnou úlohou');
assert.equal(result.task.notes, 'Opravár chce súhlas majiteľa', 'odpoveď sa orezáva');
assert.equal(result.task.series_id, secondId, 'nová úloha je samostatná, nie výskyt pôvodnej série');
assert.equal(result.task.notify_creator_on_complete, true);

const jobs = await rows(`select task_id,recipient_id,kind,status from public.notification_jobs order by created_at`);
assert.ok(jobs.some((j) => j.task_id === secondId && j.recipient_id === IVAN && j.kind === 'task_assigned' && j.status === 'queued'), 'nový príjemca dostane push');
assert.ok(jobs.some((j) => j.task_id === secondId && j.kind === 'task_due' && j.status === 'queued'), 'nová úloha má vlastné pripomienky');
assert.ok(jobs.filter((j) => j.task_id === first && ['task_due', 'task_assigned'].includes(j.kind)).every((j) => j.status === 'cancelled'), 'pôvodnej úlohe sa zrušia pripomienky aj nedoručený push');
const events = await rows(`select task_id,event_type,payload from public.task_events where task_id in ($1,$2) order by id`, [first, secondId]);
assert.ok(events.some((e) => e.task_id === first && e.event_type === 'handed_off' && e.payload.to === IVAN && e.payload.new_task_id === secondId));
assert.ok(events.some((e) => e.task_id === secondId && e.event_type === 'created' && e.payload.parent_task_id === first));

// ── Offline rad: opakované odoslanie tej istej mutácie nič nezdvojí ───────────
const replay = await handoff(first, { newTaskId: secondId, mutationId: mutation });
assert.equal(replay.task.id, secondId);
assert.equal((await one(`select count(*)::int c from public.tasks where parent_task_id=$1`, [first])).c, 1);

// ── Na posunutú úlohu sa už nedá odpovedať, ani ju dokončiť ───────────────────
await assert.rejects(() => handoff(first, { newTaskId: crypto.randomUUID(), mutationId: crypto.randomUUID() }), /TASK_NOT_EDITABLE/);
await assert.rejects(() => db.query(`select public.api_complete_task($1,gen_random_uuid())`, [first]), /TASK_NOT_EDITABLE/);

// ── Reťaz pokračuje: Ivan odpovie späť Ivke, thread_id ostáva koreň ───────────
await as(IVAN);
const thirdId = crypto.randomUUID();
const back = await handoff(secondId, { newTaskId: thirdId, mutationId: crypto.randomUUID(), to: DOMI, notes: 'Majiteľ súhlasí, objednaj ho' });
assert.equal(back.task.parent_task_id, secondId);
assert.equal(back.task.thread_id, first, 'celá reťaz zdieľa koreň');
const thread = await rows(`select id from public.tasks where id=$1 or thread_id=$1 order by created_at, id`, [first]);
assert.equal(thread.length, 3);

// ── Oprávnenia a validácia ────────────────────────────────────────────────────
await assert.rejects(() => handoff(thirdId, { newTaskId: crypto.randomUUID(), mutationId: crypto.randomUUID(), to: IVAN }), /ONLY_ASSIGNEE_CAN_HANDOFF/, 'odpovedá iba ten, komu je úloha priradená');
await as(DOMI);
await assert.rejects(() => handoff(thirdId, { newTaskId: crypto.randomUUID(), mutationId: crypto.randomUUID(), notes: '   ' }), /HANDOFF_NOTE_REQUIRED/);
await assert.rejects(() => handoff(thirdId, { newTaskId: crypto.randomUUID(), mutationId: crypto.randomUUID(), to: DOMI }), /INVALID_ASSIGNEE/, 'sebe sa posunúť nedá');
await assert.rejects(() => handoff(thirdId, { newTaskId: crypto.randomUUID(), mutationId: crypto.randomUUID(), to: OTHER }), /INVALID_ASSIGNEE/, 'iba člen skupiny');
await assert.rejects(() => handoff(thirdId, { newTaskId: thirdId, mutationId: crypto.randomUUID() }), /INVALID_HANDOFF/);
await as(OTHER);
await assert.rejects(() => handoff(thirdId, { newTaskId: crypto.randomUUID(), mutationId: crypto.randomUUID() }), /TASK_NOT_FOUND/, 'cudzia skupina úlohu nevidí');

// ── Atomickosť: chyba pri zakladaní novej úlohy nechá pôvodnú aktívnu ────────
await as(DOMI);
await assert.rejects(() => handoff(thirdId, { newTaskId: crypto.randomUUID(), mutationId: crypto.randomUUID(), title: '   ' }));
const still = await one(`select status,handed_off_to from public.tasks where id=$1`, [thirdId]);
assert.equal(still.status, 'pending', 'zlyhané posunutie nesmie pôvodnú úlohu zavrieť');
assert.equal(still.handed_off_to, null);
assert.ok((await rows(`select status from public.notification_jobs where task_id=$1 and kind='task_due'`, [thirdId])).some((j) => j.status === 'queued'), 'pripomienky ostali');

// ── Vymazanie posunutej úlohy zachová stav pre genézu ─────────────────────────
await as(IVAN);
const deleted = await one(`select (public.api_delete_task($1,gen_random_uuid())).status s`, [first]);
assert.equal(deleted.s, 'handed_off');

// ── Opakovaná úloha „až keď splním": séria pokračuje ako po splnení ───────────
const daily = await createTask(IVAN, { rule: 'daily' });
await handoff(daily, { newTaskId: crypto.randomUUID(), mutationId: crypto.randomUUID(), to: DOMI });
const series = await rows(`select status,assigned_to from public.tasks where series_id=$1 order by occurrence_at`, [daily]);
assert.deepEqual(series.map((t) => t.status), ['handed_off', 'pending'], 'ďalší výskyt vznikne');
assert.equal(series[1].assigned_to, IVAN, 'ďalší výskyt patrí pôvodnému príjemcovi');

// ── Séria „v každom termíne": posunutý najnovší výskyt sériu nezastaví ────────
const each = await createTask(IVAN, { rule: 'weekly', mode: 'each', due: `now()-interval '10 minutes'` });
await handoff(each, { newTaskId: crypto.randomUUID(), mutationId: crypto.randomUUID(), to: DOMI });
await db.query(`select public.api_generate_recurring_occurrences()`);
assert.equal((await one(`select count(*)::int c from public.tasks where series_id=$1 and status='pending'`, [each])).c, 1);

// ── Práva a handshake ─────────────────────────────────────────────────────────
const signature = 'public.api_handoff_task(uuid,uuid,uuid,uuid,text,text,timestamptz,text,integer,integer,text,text,boolean,integer,integer)';
assert.equal((await one(`select has_function_privilege('anon',$1,'EXECUTE') a`, [signature])).a, false);
assert.equal((await one(`select has_function_privilege('authenticated',$1,'EXECUTE') a`, [signature])).a, true);
const caps = (await one(`select public.get_backend_capabilities() c`)).c;
assert.equal(caps.schema_version, 18);
assert.equal(caps.task_handoff, true);

await db.close();
console.log('TASK HANDOFF SQL OK');

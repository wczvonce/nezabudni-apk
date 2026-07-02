import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile('supabase/functions/push-worker/index.ts', 'utf8');
assert.match(worker, /idempotency_key:\s*job\.id/, 'OneSignal retry musí používať stabilný idempotency_key');
assert.match(worker, /AbortSignal\.timeout\(20_000\)/, 'OneSignal request musí mať timeout');
assert.match(worker, /ttl:\s*notificationTtl\(job, task\)/, 'Reminder push musí používať kontrolované TTL');
assert.match(worker, /\.eq\('status', 'processing'\)/, 'Zrušenie jobu musí meniť iba processing job');
assert.match(worker, /versionMatch/, 'Worker musí zrušiť job zo starej verzie úlohy');
assert.match(worker, /effectiveDue/, 'Worker musí pred odoslaním kontrolovať aktuálny due alebo snooze čas');
assert.match(worker, /graceMs/, 'Worker musí zahodiť príliš staré reminder joby');
assert.doesNotMatch(worker, /Access-Control-Allow-Origin[^\n]*\*/, 'Worker nesmie mať CORS wildcard');
// Issue 14: plánované pripomienky majú vysokú technickú push prioritu, nie každá správa.
assert.match(worker, /function isScheduledReminder/, 'plánované pripomienky majú vlastnú kategóriu');
assert.match(worker, /task_pre[\s\S]{0,60}task_due[\s\S]{0,60}task_repeat/, 'reminder kinds: task_pre/due/repeat');
assert.match(worker, /priority:\s*\(isScheduledReminder\(job\.kind\)[^\n]*\?\s*10/, 'pripomienky → priorita 10 (FCM high)');
// Issue 11: queued joby sa re-evaluujú pred odoslaním podľa AKTUÁLNEHO stavu.
assert.match(worker, /loadTask\(supabase, job\.task_id\)/, 'pred odoslaním sa načíta aktuálny stav úlohy');
assert.match(worker, /task\.assigned_to !== job\.recipient_id/, 're-eval vzťahu používateľa k úlohe (autorizácia)');
assert.match(worker, /task\.deleted_at \|\| task\.status !== 'pending'/, 're-eval terminálneho stavu úlohy');
assert.match(worker, /task\.acknowledged_at/, 're-eval potvrdenia (acknowledged)');
// Issue 2: ohraničený beh + bezpečné vrátenie nedokončených jobov.
assert.match(worker, /p_limit:\s*25/, 'bounded batch (claim limit)');
assert.match(worker, /WORKER_DEADLINE_MS/, 'execution deadline');
assert.match(worker, /deadlineReached = true; break/, 'deadline zastaví branie nových jobov');
assert.match(worker, /rpc\('requeue_unfinished_jobs', \{ p_job_ids: claimedIds \}\)/, 'nedokončené joby sa vrátia do fronty bez spálenia attempt_count');
console.log('WORKER STATIC OK');

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
console.log('WORKER STATIC OK');

// 018: odpoveď na úlohu offline – v outboxe čaká jedna mutácia 'handoff', sync
// nesmie zahodiť ani posunutú pôvodnú úlohu, ani novú úlohu, a flush uloží
// obidve úlohy zo serverovej odpovede { original, task }.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
let online = true;
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
Object.defineProperty(globalThis.navigator, 'onLine', { get: () => online, configurable: true });

const { __setSupabaseForTests } = await import('../src/lib/supabase.js');
const { initTaskService, closeTaskService, fetchTasks, flushOutbox, handoffTask, fetchThread, cachedTasks } = await import('../src/services/task-service.js');

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAIR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORIG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const srv = { tasks: [], rpcError: null, rpcResult: null, calls: [], lastOr: null };
function builder(result) {
  const b = {
    select: () => b, eq: () => b, in: () => b, or: (filter) => { srv.lastOr = filter; return b; },
    order: () => Promise.resolve(result),
    then: (ok, err) => Promise.resolve(result).then(ok, err),
  };
  return b;
}
__setSupabaseForTests({
  rpc: async (name, payload) => {
    srv.calls.push({ name, payload });
    return srv.rpcError ? { data: null, error: srv.rpcError } : { data: srv.rpcResult, error: null };
  },
  from: (table) => builder(table === 'tasks' ? { data: srv.tasks, error: null } : { data: [], error: null }),
});
await initTaskService({ userId: USER, demoMode: false, pairId: PAIR });

function task(id, patch = {}) {
  return {
    id, pair_id: PAIR, created_by: PARTNER, assigned_to: USER, title: 'Zavolať opravára', notes: 'číslo v prílohe',
    due_at: new Date(Date.now() + 3_600_000).toISOString(), timezone: 'Europe/Bratislava', priority: 2,
    pre_reminder_minutes: 0, recurrence_rule: 'none', recurrence_mode: 'after', series_id: id,
    occurrence_at: new Date(Date.now() + 3_600_000).toISOString(), notify_creator_on_complete: false,
    reminder_interval_seconds: 60, max_reminders: 10, reminders_sent: 0, status: 'pending', snoozed_until: null,
    acknowledged_at: null, acknowledged_by: null, completed_at: null, completed_by: null, deleted_at: null,
    parent_task_id: null, thread_id: null, handed_off_to: null, handed_off_at: null,
    created_at: new Date(Date.now() - 86_400_000).toISOString(), updated_at: new Date().toISOString(), version: 1, last_changed_by: PARTNER, ...patch,
  };
}
const input = {
  title: 'Zavolať majiteľovi', notes: '  Opravár chce súhlas majiteľa  ', assigned_to: PARTNER,
  due_at: new Date(Date.now() + 7_200_000).toISOString(), timezone: 'Europe/Bratislava', priority: 2,
  pre_reminder_minutes: 0, recurrence_rule: 'none', recurrence_mode: 'after', notify_creator_on_complete: true,
  reminder_interval_seconds: 60, max_reminders: 10,
};

const orig = task(ORIG);
srv.tasks = [orig];
await fetchTasks();

// Prázdna odpoveď sa neodošle ani do fronty.
await assert.rejects(() => handoffTask(orig, { ...input, notes: '   ' }), /HANDOFF_NOTE_REQUIRED/);

// ── Offline: jedna mutácia, dve optimistické úlohy ──────────────────────────
online = false;
const queued = await handoffTask(orig, input);
assert.equal(queued.queued, true);
assert.equal(queued.original.status, 'handed_off');
assert.equal(queued.original.handed_off_to, PARTNER);
assert.equal(queued.task.parent_task_id, ORIG);
assert.equal(queued.task.thread_id, ORIG);
assert.equal(queued.task.assigned_to, PARTNER);
assert.equal(queued.task.created_by, USER);
assert.equal(queued.task.notes, 'Opravár chce súhlas majiteľa');
const childId = queued.task.id;
assert.notEqual(childId, ORIG);

// Server chvíľu padá (500) – mutácia ostane, sync nesmie úlohy prepísať starým stavom.
online = true;
srv.rpcError = { status: 500, message: 'Internal Server Error' };
assert.equal((await flushOutbox()).processed, 0);
const afterSync = await fetchTasks();
assert.equal(afterSync.find((t) => t.id === ORIG)?.status, 'handed_off', 'pôvodná úloha nesmie po syncu ožiť');
assert.ok(afterSync.some((t) => t.id === childId), 'nová úloha z čakajúcej odpovede nesmie zmiznúť');
const rpcPayload = srv.calls.at(-1);
assert.equal(rpcPayload.name, 'api_handoff_task');
assert.equal(rpcPayload.payload.p_task_id, ORIG);
assert.equal(rpcPayload.payload.p_new_id, childId, 'ID novej úlohy je stabilné pre opakované odoslanie');
assert.equal(rpcPayload.payload.p_notes, 'Opravár chce súhlas majiteľa');

// Server sa spamätá – flush uloží obe úlohy zo serverovej odpovede.
srv.rpcError = null;
srv.rpcResult = {
  original: task(ORIG, { status: 'handed_off', handed_off_to: PARTNER, handed_off_at: new Date().toISOString(), version: 2, title: 'Server pôvodná' }),
  task: task(childId, { created_by: USER, assigned_to: PARTNER, parent_task_id: ORIG, thread_id: ORIG, title: 'Server nová', created_at: new Date().toISOString() }),
};
assert.equal((await flushOutbox()).processed, 1);
const cached = await cachedTasks();
assert.equal(cached.find((t) => t.id === ORIG)?.title, 'Server pôvodná');
assert.equal(cached.find((t) => t.id === childId)?.title, 'Server nová');

// ── Online: odpoveď prejde hneď ─────────────────────────────────────────────
const second = task('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
srv.rpcResult = { original: { ...second, status: 'handed_off', version: 2 }, task: task('ffffffff-ffff-4fff-8fff-ffffffffffff', { parent_task_id: second.id, thread_id: second.id }) };
const direct = await handoffTask(second, input);
assert.equal(direct.queued, false);
assert.equal(direct.task.parent_task_id, second.id);
assert.equal(direct.original.status, 'handed_off');

// ── Genéza zo servera: filter na koreň reťaze, neplatné ID sa nepošle ───────
srv.tasks = [srv.rpcResult.original, srv.rpcResult.task];
const thread = await fetchThread(second.id);
assert.equal(thread.tasks.length, 2);
assert.equal(srv.lastOr, `id.eq.${second.id},thread_id.eq.${second.id}`);
assert.equal(await fetchThread('x),id.neq.(0'), null, 'do PostgREST filtra ide iba platné UUID');

await closeTaskService();
console.log('TASK HANDOFF SYNC OK');
process.exit(0);

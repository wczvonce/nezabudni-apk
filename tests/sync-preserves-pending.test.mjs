// Regres (audit 2026-07-11, nález A1+A2):
// A1: keď offline mutácia čaká v outboxe (flush zlyhal na 429/500) a sync
//     napriek tomu stiahne starý serverový stav, optimistická úloha NESMIE
//     zmiznúť z cache/UI (riziko duplicitného vytvorenia používateľom).
// A2: keď zlyhá dotaz na task_hidden, skryté úlohy sa NESMÚ vrátiť do cache —
//     použije sa posledný známy zoznam skrytých ID.
// Test používa mock Supabase cez __setSupabaseForTests (skutočné správanie,
// nie regex kontrola).
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
let online = true;
// node má navigator len na čítanie — prekry ho vlastným objektom cez defineProperty
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
Object.defineProperty(globalThis.navigator, 'onLine', { get: () => online, configurable: true });
// node 20+ má crypto globálne (read-only getter) — netreba nič nastavovať

const { __setSupabaseForTests } = await import('../src/lib/supabase.js');
const { initTaskService, closeTaskService, createTask, fetchTasks, flushOutbox } = await import('../src/services/task-service.js');

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAIR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// ── Mock Supabase ────────────────────────────────────────────────────────────
// serverTasks = to, čo server "vidí"; rpcError = simulovaná chyba RPC;
// hiddenError = simulované zlyhanie task_hidden dotazu; hiddenIds = obsah.
const srv = { tasks: [], rpcError: null, hiddenError: null, hiddenIds: [] };
function builder(result) {
  const b = {
    select: () => b, eq: () => b, order: () => Promise.resolve(result),
    then: (ok, err) => Promise.resolve(result).then(ok, err),
  };
  return b;
}
const mockSb = {
  rpc: async () => srv.rpcError ? { data: null, error: srv.rpcError } : { data: [], error: null },
  from: (table) => {
    if (table === 'tasks') return builder({ data: srv.tasks, error: null });
    if (table === 'task_hidden') return builder(srv.hiddenError
      ? { data: null, error: srv.hiddenError }
      : { data: srv.hiddenIds.map((id) => ({ task_id: id })), error: null });
    return builder({ data: [], error: null });
  },
};
__setSupabaseForTests(mockSb);

await initTaskService({ userId: USER, demoMode: false, pairId: PAIR });

function serverTask(id, patch = {}) {
  return {
    id, pair_id: PAIR, created_by: USER, assigned_to: USER, title: `Server ${id.slice(0, 4)}`,
    notes: '', due_at: new Date(Date.now() + 3_600_000).toISOString(), timezone: 'Europe/Bratislava',
    priority: 1, pre_reminder_minutes: 0, recurrence_rule: 'none', recurrence_mode: 'after',
    series_id: id, occurrence_at: new Date(Date.now() + 3_600_000).toISOString(),
    notify_creator_on_complete: false, reminder_interval_seconds: 60, max_reminders: 10,
    reminders_sent: 0, status: 'pending', snoozed_until: null, acknowledged_at: null,
    acknowledged_by: null, completed_at: null, completed_by: null, deleted_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    version: 1, last_changed_by: USER, ...patch,
  };
}

// ── A1: offline create → transient 500 pri flushi → fetch nesmie zmazať úlohu ─
online = false;
const created = await createTask({
  title: 'Optimisticka uloha', notes: '', assigned_to: USER,
  due_at: new Date(Date.now() + 3_600_000).toISOString(), timezone: 'Europe/Bratislava',
  priority: 1, pre_reminder_minutes: 0, recurrence_rule: 'none', recurrence_mode: 'after',
  notify_creator_on_complete: false, reminder_interval_seconds: 60, max_reminders: 10,
});
assert.ok(created.queued, 'Offline create sa mal zaradiť do outboxu');
const newId = created.task.id;

online = true;
srv.rpcError = { status: 500, message: 'Internal Server Error' }; // transient → mutácia ostane pending
const flush1 = await flushOutbox();
assert.equal(flush1.processed, 0, 'Transient chyba nesmie mutáciu spracovať');

srv.tasks = []; // server má STARÝ stav (o úlohe nevie)
const afterSync = await fetchTasks();
assert.ok(afterSync.some((t) => t.id === newId),
  'A1: optimistická úloha s čakajúcou mutáciou ZMIZLA zo synchronizovaného zoznamu');

// server sa spamätá → flush prejde a merge už nie je potrebný
srv.rpcError = null;
const flush2 = await flushOutbox();
assert.equal(flush2.processed, 1, 'Po zotavení servera sa mutácia mala spracovať');

// ── A1b: novšia serverová verzia (partner) má prednosť pred lokálnou ─────────
const contested = serverTask('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { version: 7, title: 'Server v7' });
srv.tasks = [contested];
await fetchTasks();
online = false;
// offline update (optimistická verzia 8 lokálne)... simulujeme priamym enqueue cez updateTask
const { updateTask } = await import('../src/services/task-service.js');
await updateTask(contested, { title: 'Lokalna zmena', notes: '', assigned_to: USER, due_at: contested.due_at, timezone: contested.timezone, priority: 1, pre_reminder_minutes: 0, recurrence_rule: 'none', recurrence_mode: 'after', notify_creator_on_complete: false, reminder_interval_seconds: 60, max_reminders: 10 });
online = true;
srv.rpcError = { status: 500, message: 'transient' };
await flushOutbox();
srv.tasks = [{ ...contested, version: 9, title: 'Partner v9' }]; // partner medzitým zmenil
const contestedAfter = await fetchTasks();
const row = contestedAfter.find((t) => t.id === contested.id);
assert.equal(row?.title, 'Partner v9', 'A1b: novšia serverová verzia musí vyhrať nad staršou lokálnou');
srv.rpcError = null;
// konfliktná mutácia sa pri flushi vyrieši cez failed-flow — tu ju len zahodíme
const { discardFailedOutbox } = await import('../src/services/task-service.js');
await flushOutbox(); await discardFailedOutbox().catch(() => {});

// ── A2: zlyhanie task_hidden nesmie vrátiť skryté úlohy ──────────────────────
const visibleT = serverTask('11111111-1111-4111-8111-111111111111');
const hiddenT = serverTask('22222222-2222-4222-8222-222222222222');
srv.tasks = [visibleT, hiddenT];
srv.hiddenIds = [hiddenT.id];
srv.hiddenError = null;
const ok1 = await fetchTasks();
assert.ok(!ok1.some((t) => t.id === hiddenT.id), 'Skrytá úloha nemá byť v zozname (sanity)');

srv.hiddenError = { message: 'permission denied (simulované zlyhanie)' };
const ok2 = await fetchTasks();
assert.ok(!ok2.some((t) => t.id === hiddenT.id),
  'A2: pri zlyhaní task_hidden sa skrytá úloha VRÁTILA do zoznamu');
assert.ok(ok2.some((t) => t.id === visibleT.id), 'Viditeľná úloha musí ostať');

await closeTaskService();
console.log('SYNC PRESERVES PENDING OK');
process.exit(0);

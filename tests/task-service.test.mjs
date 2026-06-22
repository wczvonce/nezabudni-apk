import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

const {
  initTaskService,
  closeTaskService,
  cachedTasks,
  createTask,
  updateTask,
  snoozeTask,
  acknowledgeTask,
  completeTask,
  deleteTask,
} = await import('../src/services/task-service.js');

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAIR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

await initTaskService({ userId: USER_A, demoMode: true, pairId: PAIR });
const created = await createTask({
  assigned_to: USER_A,
  title: 'Test demo úloha',
  notes: 'poznámka',
  due_at: new Date(Date.now() + 3600_000).toISOString(),
  priority: 2,
  recurrence_rule: 'none',
  recurrence_mode: 'after',
  notify_creator_on_complete: false,
  reminder_interval_seconds: 60,
  max_reminders: 10,
});
assert.equal(created.task.title, 'Test demo úloha');
assert.equal((await cachedTasks()).length, 1);

const updated = await updateTask(created.task, {
  assigned_to: USER_A,
  title: 'Upravená úloha',
  notes: '',
  due_at: created.task.due_at,
  priority: 3,
  recurrence_rule: 'none',
  recurrence_mode: 'after',
  notify_creator_on_complete: false,
  reminder_interval_seconds: 300,
  max_reminders: 5,
});
assert.equal(updated.task.title, 'Upravená úloha');
assert.equal(updated.task.version, created.task.version + 1);

const snoozed = await snoozeTask(updated.task, 15);
assert.ok(snoozed.task.snoozed_until);
const acknowledged = await acknowledgeTask(snoozed.task);
assert.ok(acknowledged.task.acknowledged_at);
const completed = await completeTask(acknowledged.task);
assert.equal(completed.task.status, 'completed');
const deleted = await deleteTask(completed.task);
assert.equal(deleted.task.status, 'cancelled');
assert.ok(deleted.task.deleted_at);
await closeTaskService();

// Lokálne databázy musia byť striktne oddelené podľa používateľa.
await initTaskService({ userId: USER_B, demoMode: true, pairId: PAIR });
assert.equal((await cachedTasks()).length, 0, 'Používateľ B nesmie vidieť cache používateľa A');
await closeTaskService();
await initTaskService({ userId: USER_A, demoMode: true, pairId: PAIR });
assert.equal((await cachedTasks()).length, 1, 'Používateľ A musí dostať svoju vlastnú cache');
await closeTaskService();

console.log('TASK SERVICE OK');

// Regres (2026-07-08): záložka „Hotové" musí radiť úlohy od NAJNOVŠIE splnenej
// (completed_at zostupne). Pred opravou platilo univerzálne radenie podľa
// termínu vzostupne, takže najstaršie hotové úlohy boli navrchu.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

const html = (await readFile('index.html', 'utf8'))
  .replace(/<link[^>]+fonts\.googleapis[^>]*>/g, '')
  .replace(/<link[^>]+fonts\.gstatic[^>]*>/g, '')
  .replace(/<script type="module" src="\/src\/main\.js"><\/script>/, '');
const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
for (const key of ['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent','localStorage','location','confirm']) {
  if (key === 'confirm') globalThis.confirm = () => true;
  else if (key === 'location') globalThis.location = dom.window.location;
  else globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });

const { initTaskService, closeTaskService } = await import('../src/services/task-service.js');
const { setState, resetState } = await import('../src/state/store.js');
const { bindUi, showApp, render } = await import('../src/ui/app-ui.js');

const USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAIR='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
await initTaskService({ userId: USER, demoMode: true, pairId: PAIR });
bindUi();

const now = Date.now();
function completedTask(id, dueOffsetMs, completedOffsetMs) {
  return {
    id, pair_id: PAIR, created_by: USER, assigned_to: USER,
    title: `Uloha ${id.slice(0, 4)}`, notes: '', due_at: new Date(now + dueOffsetMs).toISOString(), timezone: 'Europe/Bratislava',
    priority: 1, pre_reminder_minutes: 0, recurrence_rule: 'none', recurrence_mode: 'after', series_id: id,
    occurrence_at: new Date(now + dueOffsetMs).toISOString(), notify_creator_on_complete: false, reminder_interval_seconds: 60,
    max_reminders: 10, reminders_sent: 0, status: 'completed', snoozed_until: null, acknowledged_at: null, acknowledged_by: null,
    completed_at: new Date(now + completedOffsetMs).toISOString(), completed_by: USER, deleted_at: null,
    created_at: new Date(now - 86_400_000).toISOString(), updated_at: new Date(now + completedOffsetMs).toISOString(),
    version: 2, last_changed_by: USER,
  };
}

// Zámerne PROTIBEŽNÉ poradia: podľa termínu vzostupne (staré radenie) by bolo
// poradie A,B,C — podľa času splnenia zostupne (správne) je C,B,A. Test tak
// jednoznačne odlíši obe radenia (overené mutačne).
const taskA = completedTask('11111111-1111-4111-8111-111111111111', -3 * 3_600_000, -7_200_000); // najstarší termín, splnená NAJSTARŠIE
const taskB = completedTask('22222222-2222-4222-8222-222222222222', -2 * 3_600_000, -3_600_000); // stredný termín, splnená v strede
const taskC = completedTask('33333333-3333-4333-8333-333333333333', -1 * 3_600_000, -60_000);    // najnovší termín, splnená NAJNOVŠIE

setState({ demoMode: true, user: { id: USER, email: 'a@example.test' }, profile: { id: USER, display_name: 'Ivan' }, pair: { id: PAIR, name: 'I+D' }, members: [{ id: USER, display_name: 'Ivan' }, { id: PARTNER, display_name: 'Dominika' }], tasks: [taskB, taskA, taskC], booted: true, activeTab: 'done' });
showApp();
render();

const order = [...document.querySelectorAll('#main [data-open-task]')].map((el) => el.dataset.openTask);
assert.equal(order.length, 3, `Očakávané 3 hotové úlohy, je ich ${order.length}`);
assert.deepEqual(order, [taskC.id, taskB.id, taskA.id], `Hotové nie sú od najnovšie splnenej: ${order.map((id) => id.slice(0, 4)).join(',')}`);

// Odmietnuté: najnovšie zmenené hore.
const rej = (id, updOffsetMs) => ({ ...completedTask(id, -3_600_000, updOffsetMs), status: 'rejected', completed_at: null, completed_by: null, rejection_reason: 'test', updated_at: new Date(now + updOffsetMs).toISOString() });
const rejOld = rej('44444444-4444-4444-8444-444444444444', -7_200_000);
const rejNew = rej('55555555-5555-4555-8555-555555555555', -60_000);
setState({ tasks: [rejOld, rejNew], activeTab: 'rejected' });
render();
const rejOrder = [...document.querySelectorAll('#main [data-open-task]')].map((el) => el.dataset.openTask);
assert.deepEqual(rejOrder, [rejNew.id, rejOld.id], 'Odmietnuté nie sú od najnovšej');

await closeTaskService();
resetState();
console.log('DONE TAB SORT OK');
process.exit(0);

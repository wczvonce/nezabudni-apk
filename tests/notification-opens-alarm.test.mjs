// Regres (2026-07-08): klik na push notifikáciu MOJEJ čakajúcej úlohy musí
// otvoriť ALARMOVÉ okno (Hotovo / OK / Odložiť / Otvoriť úlohu), nie editačný
// formulár s klávesnicou. Formulár (detail) sa otvára len pre úlohy, kde alarm
// nedáva zmysel (splnené/odmietnuté/partnerove).
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

const { initTaskService, closeTaskService, cacheTasks } = await import('../src/services/task-service.js');
const { setState, resetState } = await import('../src/state/store.js');
const { bindUi, showApp, openTaskFromNotification } = await import('../src/ui/app-ui.js');

const USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAIR='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
await initTaskService({ userId: USER, demoMode: true, pairId: PAIR });
bindUi();

function baseTask(id, patch = {}) {
  return {
    id, pair_id: PAIR, created_by: PARTNER, assigned_to: USER,
    title: `Uloha ${id.slice(0, 4)}`, notes: '', due_at: new Date(Date.now() + 3_600_000).toISOString(), timezone: 'Europe/Bratislava',
    priority: 1, pre_reminder_minutes: 0, recurrence_rule: 'none', recurrence_mode: 'after', series_id: id,
    occurrence_at: new Date(Date.now() + 3_600_000).toISOString(), notify_creator_on_complete: false, reminder_interval_seconds: 60,
    max_reminders: 10, reminders_sent: 0, status: 'pending', snoozed_until: null, acknowledged_at: null, acknowledged_by: null,
    completed_at: null, completed_by: null, deleted_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    version: 1, last_changed_by: PARTNER, ...patch,
  };
}
const myFuture = baseTask('11111111-1111-4111-8111-111111111111'); // splatná o hodinu
const myDue = baseTask('44444444-4444-4444-8444-444444444444', { due_at: new Date(Date.now() - 60_000).toISOString(), occurrence_at: new Date(Date.now() - 60_000).toISOString() });
const myDone = baseTask('22222222-2222-4222-8222-222222222222', { status: 'completed', completed_at: new Date().toISOString(), completed_by: USER });
const partnersTask = baseTask('33333333-3333-4333-8333-333333333333', { assigned_to: PARTNER, created_by: USER });

await cacheTasks([myFuture, myDue, myDone, partnersTask]);
setState({ demoMode: true, user: { id: USER, email: 'a@example.test' }, profile: { id: USER, display_name: 'Ivan' }, pair: { id: PAIR, name: 'I+D' }, members: [{ id: USER, display_name: 'Ivan' }, { id: PARTNER, display_name: 'Dominika' }], tasks: [myFuture, myDue, myDone, partnersTask], booted: true, activeTab: 'all' });
showApp();

const alarmShown = () => document.getElementById('alarmScrim').classList.contains('show');
const sheetShown = () => document.getElementById('taskSheet').classList.contains('show');

// 0) Moja SPLATNÁ úloha → ALARMOVÉ okno (mohlo sa zobraziť aj samo cez
// checkDueAlarm pri showApp — klik ho má v každom prípade ukazovať pre ňu).
openTaskFromNotification(myDue.id);
assert.ok(alarmShown(), 'Klik na push splatnej úlohy mal otvoriť alarmové okno');
assert.ok(!sheetShown(), 'Formulár sa pri splatnej úlohe nemal otvoriť');
assert.equal(document.getElementById('alarmTitle').textContent, myDue.title);
document.getElementById('alarmOkBtn').click();
await new Promise((resolve) => setTimeout(resolve, 100));

// 1) Moja NESPLATNÁ úloha (push „nová úloha od partnera") → DETAIL, nie alarm.
// Alarm na nesplatnej úlohe by cez „OK — počul som" vypol budúce pripomienky
// a „Odložiť 15 min" by presunul termín dopredu.
openTaskFromNotification(myFuture.id);
assert.ok(!alarmShown(), 'Nesplatná úloha nemá zobrazovať alarm');
assert.ok(sheetShown(), 'Nesplatná úloha mala otvoriť detail');
document.getElementById('closeSheetBtn').click();
await new Promise((resolve) => setTimeout(resolve, 50));

// 2) Splnená úloha (napr. push „partner splnil") → detail, nie alarm.
openTaskFromNotification(myDone.id);
assert.ok(!alarmShown(), 'Splnená úloha nemá zobrazovať alarm');
assert.ok(sheetShown(), 'Splnená úloha mala otvoriť detail');
document.getElementById('closeSheetBtn').click();

// 3) Partnerova úloha → detail, nie alarm.
openTaskFromNotification(partnersTask.id);
assert.ok(!alarmShown(), 'Partnerova úloha nemá zobrazovať alarm');
assert.ok(sheetShown(), 'Partnerova úloha mala otvoriť detail');

await closeTaskService();
resetState();
console.log('NOTIFICATION OPENS ALARM OK');
process.exit(0);

// 018: odpoveď na úlohu v UI – tlačidlo „↪ Odpovedať" len na mojej aktívnej
// úlohe (a len s backendom 18+), formulár predvolí toho, kto úlohu zadal,
// odpoveď je povinná, pôvodná úloha skončí v Hotových ako „Posunuté" a detail
// novej úlohy ukazuje genézu.
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

const { initTaskService, closeTaskService, cachedTasks, cacheTasks } = await import('../src/services/task-service.js');
const { setState, getState, resetState } = await import('../src/state/store.js');
const { bindUi, showApp, render, openTaskSheet } = await import('../src/ui/app-ui.js');

const IVKA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IVAN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DOMI = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PAIR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORIG = '11111111-1111-4111-8111-111111111111';
const OTHERS = '22222222-2222-4222-8222-222222222222';
await initTaskService({ userId: IVKA, demoMode: true, pairId: PAIR });
bindUi();

const now = Date.now();
const base = (id, patch) => ({
  id, pair_id: PAIR, created_by: IVAN, assigned_to: IVKA, title: 'Zavolať opravára', notes: 'číslo je v prílohe',
  due_at: new Date(now + 3_600_000).toISOString(), timezone: 'Europe/Bratislava', priority: 2, pre_reminder_minutes: 0,
  recurrence_rule: 'none', recurrence_mode: 'after', series_id: id, occurrence_at: new Date(now + 3_600_000).toISOString(),
  notify_creator_on_complete: false, reminder_interval_seconds: 60, max_reminders: 10, reminders_sent: 0, status: 'pending',
  snoozed_until: null, acknowledged_at: null, acknowledged_by: null, completed_at: null, completed_by: null, deleted_at: null,
  created_at: new Date(now - 86_400_000).toISOString(), updated_at: new Date(now - 86_400_000).toISOString(), version: 1, last_changed_by: IVAN, ...patch,
});
const orig = base(ORIG);
const forIvan = base(OTHERS, { assigned_to: IVAN, title: 'Ivanova úloha' });
await cacheTasks([orig, forIvan]);
const members = [{ id: IVKA, display_name: 'Ivka' }, { id: IVAN, display_name: 'Ivan' }, { id: DOMI, display_name: 'Dominika' }];
setState({ demoMode: true, user: { id: IVKA, email: 'ivka@example.test' }, profile: { id: IVKA, display_name: 'Ivka' }, pair: { id: PAIR, name: 'Skupina' }, members, tasks: [orig, forIvan], booted: true, activeTab: 'all' });
showApp();
render();

const $ = (sel) => document.querySelector(sel);
const until = async (check, label) => {
  for (let i = 0; i < 100; i += 1) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail(`Čakanie vypršalo: ${label}`);
};

// ── Tlačidlo: len na mojej aktívnej úlohe ────────────────────────────────────
assert.ok($(`[data-reply-task="${ORIG}"]`), 'moja aktívna úloha má „↪ Odpovedať"');
assert.equal($(`[data-reply-task="${OTHERS}"]`), null, 'na cudzej úlohe sa odpovedať nedá');
// Mimo ukážkového režimu tlačidlo ukáže až backend so schémou 18.
setState({ demoMode: false, backendSchema: 17 }); render();
assert.equal($(`[data-reply-task="${ORIG}"]`), null, 'starý backend (bez migrácie 018) tlačidlo neukáže');
setState({ backendSchema: 18 }); render();
assert.ok($(`[data-reply-task="${ORIG}"]`), 'backend 18 tlačidlo ukáže');
setState({ demoMode: true, backendSchema: null }); render();

// ── Formulár odpovede ────────────────────────────────────────────────────────
$(`[data-reply-task="${ORIG}"]`).click();
assert.equal($('#sheetTitle').textContent, '↪ Odpovedať na úlohu');
const options = [...$('#fAssigned').options].map((o) => o.value);
assert.deepEqual(options.sort(), [IVAN, DOMI].sort(), 'posunúť sa dá iba inému členovi skupiny');
assert.equal($('#fAssigned').value, IVAN, 'predvolene ten, kto úlohu zadal');
assert.equal($('#fTitle').value, 'Zavolať opravára');
assert.equal($('#fNoteLabel').textContent, 'Odpoveď – čo treba urobiť ďalej');
assert.equal($('#fThread').hidden, false, 'nad formulárom je genéza');
assert.match($('#fThread').textContent, /číslo je v prílohe/, 'genéza ukazuje pôvodnú poznámku');
assert.match($('#fThread').textContent, /Tvoja odpoveď vytvorí ďalší krok/);

// Bez odpovede sa nič neodošle.
$('#taskForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
await until(() => /Napíš odpoveď/.test($('#toast').textContent), 'chyba prázdnej odpovede');
assert.equal((await cachedTasks()).find((t) => t.id === ORIG).status, 'pending');

$('#fNote').value = 'Opravár chce súhlas majiteľa, zavolaj mu prosím';
$('#taskForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
await until(async () => (await cachedTasks()).some((t) => t.parent_task_id === ORIG), 'vznik novej úlohy');
const all = await cachedTasks();
const child = all.find((t) => t.parent_task_id === ORIG);
assert.equal(all.find((t) => t.id === ORIG).status, 'handed_off');
assert.equal(all.find((t) => t.id === ORIG).handed_off_to, IVAN);
assert.equal(child.assigned_to, IVAN);
assert.equal(child.created_by, IVKA);
assert.equal(child.thread_id, ORIG);
assert.equal(child.notes, 'Opravár chce súhlas majiteľa, zavolaj mu prosím');
await until(() => /Posunuté – Ivan to má v úlohách/.test($('#toast').textContent), 'potvrdenie posunutia');
assert.ok(!$('#taskSheet').classList.contains('show'), 'formulár sa zavrie');

// ── Karty: nová úloha so štítkom, pôvodná v Hotových ako Posunuté ───────────
setState({ activeTab: 'all' }); render();
assert.match($(`[data-open-task="${child.id}"]`).textContent, /↪ odpoveď na úlohu/);
assert.equal($(`[data-open-task="${ORIG}"]`), null, 'posunutá úloha už nie je medzi aktívnymi');
setState({ activeTab: 'done' }); render();
const closedCard = $(`[data-open-task="${ORIG}"]`);
assert.ok(closedCard, 'posunutá úloha je v Hotových');
assert.match(closedCard.textContent, /Posunuté → Ivan/);
assert.equal(closedCard.querySelector('[data-complete-task]'), null, 'posunutú úlohu už nemožno splniť');
assert.equal(closedCard.querySelector('[data-reply-task]'), null, 'na posunutú úlohu sa už neodpovedá');
assert.ok(closedCard.querySelector('[data-hide-task]'), 'dá sa odstrániť zo svojho zoznamu');

// ── Detail novej úlohy: genéza dvoch krokov ──────────────────────────────────
openTaskSheet(getState().tasks.find((t) => t.id === child.id));
const steps = [...document.querySelectorAll('#fThread .thread-step')];
assert.equal(steps.length, 2);
assert.match(steps[0].textContent, /Ivan → Ivka/);
assert.match(steps[0].textContent, /Posunuté → Ivan/);
assert.match(steps[1].textContent, /Ivka → Ivan/);
assert.match(steps[1].textContent, /táto úloha/);
assert.ok(steps[1].classList.contains('current'));
// Bežná nová úloha genézu nemá a formulár je späť v normálnom režime.
openTaskSheet(null);
assert.equal($('#fThread').hidden, true);
assert.equal($('#fNoteLabel').textContent, 'Poznámka (voliteľné)');
assert.equal($('#sheetTitle').textContent, 'Nová úloha');

await closeTaskService();
resetState();
console.log('TASK HANDOFF UI OK');
process.exit(0);

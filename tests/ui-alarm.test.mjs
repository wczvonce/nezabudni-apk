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
const realDateNow = Date.now;
let fakeNow = realDateNow();
Date.now = () => fakeNow;

const { initTaskService, closeTaskService } = await import('../src/services/task-service.js');
const { setState, resetState, getState } = await import('../src/state/store.js');
const { bindUi, showApp, render } = await import('../src/ui/app-ui.js');

const USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAIR='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
await initTaskService({ userId: USER, demoMode: true, pairId: PAIR });
bindUi();

const baseTask = {
  id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd', pair_id:PAIR, created_by:PARTNER, assigned_to:USER,
  title:'Alarm test', notes:'', due_at:new Date(Date.now()-60_000).toISOString(), timezone:'Europe/Bratislava',
  priority:1, pre_reminder_minutes:0, recurrence_rule:'none', recurrence_mode:'after', series_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  occurrence_at:new Date(Date.now()-60_000).toISOString(), notify_creator_on_complete:false, reminder_interval_seconds:60,
  max_reminders:10, reminders_sent:0, status:'pending', snoozed_until:null, acknowledged_at:null, acknowledged_by:null,
  completed_at:null, completed_by:null, deleted_at:null, created_at:new Date().toISOString(), updated_at:new Date().toISOString(),
  version:1, last_changed_by:PARTNER,
};
setState({ demoMode:true, user:{id:USER,email:'a@example.test'}, profile:{id:USER,display_name:'Ivan'}, pair:{id:PAIR,name:'I+D'}, members:[{id:USER,display_name:'Ivan'},{id:PARTNER,display_name:'Dominika'}], tasks:[baseTask], booted:true });
showApp();
assert.ok(document.getElementById('alarmScrim').classList.contains('show'), 'Alarm sa mal zobraziť');

// Tlačidlo „Otvoriť úlohu“ musí otvoriť detail; pred opravou closeAlarm() vynuloval referenciu skôr.
document.getElementById('alarmOpenBtn').click();
assert.ok(document.getElementById('taskSheet').classList.contains('show'), 'Detail úlohy sa neotvoril z alarmu');
assert.equal(document.getElementById('fTitle').value, 'Alarm test');
document.getElementById('closeSheetBtn').click();

// Ak používateľ iba otvorí detail a nepotvrdí úlohu, vizuálny alarm sa má
// po nastavenom intervale zobraziť znova aj bez zmeny verzie.
fakeNow += 61_000;
render();
assert.ok(document.getElementById('alarmScrim').classList.contains('show'), 'Alarm sa po intervale nezopakoval');
document.getElementById('alarmOpenBtn').click();
document.getElementById('closeSheetBtn').click();

// Nový alarmový cyklus rovnakej úlohy (vyššia verzia/nový čas) sa musí zobraziť znova.
const nextCycle = { ...baseTask, version:2, snoozed_until:new Date(Date.now()-1_000).toISOString(), updated_at:new Date().toISOString() };
setState({ tasks:[nextCycle] });
render();
assert.ok(document.getElementById('alarmScrim').classList.contains('show'), 'Nový alarmový cyklus sa nezobrazil');

// Regres (bug z 2026-07-06): „Hotovo" v alarme musí úlohu SPLNIŤ. Pred opravou
// handleAlarmAction('done') spadlo v mutateTask do snooze vetvy bez minút a
// používateľ videl surové INVALID_SNOOZE, úloha ostala medzi plánovanými.
document.getElementById('alarmDoneBtn').click();
await new Promise((resolve) => setTimeout(resolve, 100));
const doneTask = getState().tasks.find((t) => t.id === baseTask.id);
assert.equal(doneTask?.status, 'completed', 'Úloha po „Hotovo" z alarmu nie je splnená');
assert.ok(!document.getElementById('alarmScrim').classList.contains('show'), 'Alarm sa po „Hotovo" nezavrel');
const toastText = document.getElementById('toast').textContent;
assert.ok(!toastText.includes('INVALID'), `Toast ukazuje surovú DB chybu: ${toastText}`);
assert.equal(toastText, 'Úloha splnená', `Nečakaný toast: ${toastText}`);

await closeTaskService();
resetState();
Date.now = realDateNow;
console.log('UI ALARM OK');

process.exit(0);

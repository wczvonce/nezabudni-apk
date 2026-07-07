// Regres (2026-07-08): keď PRÍJEMCA upraví úlohu, ktorú mu partner vytvoril so
// zaškrtnutým „Upozorni ma, keď partner úlohu splní", uloženie NESMIE checkbox
// zmazať. Pred opravou updateNotifyCreatorVisibility() pri skrytí (úloha „pre
// seba" z pohľadu editora) checkbox násilne odškrtla a save zapísal false →
// tvorca potom nedostal push o splnení (reálny prípad Dominika→Ivan 2026-07-08).
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
const { setState, resetState, getState } = await import('../src/state/store.js');
const { bindUi, showApp, openTaskSheet } = await import('../src/ui/app-ui.js');

const USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';      // Ivan (príjemca, edituje)
const PARTNER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';    // Dominika (tvorkyňa, chce push)
const PAIR='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
await initTaskService({ userId: USER, demoMode: true, pairId: PAIR });
bindUi();

const task = {
  id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd', pair_id:PAIR, created_by:PARTNER, assigned_to:USER,
  title:'Uloha od partnera', notes:'', due_at:new Date(Date.now()+3_600_000).toISOString(), timezone:'Europe/Bratislava',
  priority:1, pre_reminder_minutes:0, recurrence_rule:'none', recurrence_mode:'after', series_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  occurrence_at:new Date(Date.now()+3_600_000).toISOString(), notify_creator_on_complete:true, reminder_interval_seconds:60,
  max_reminders:10, reminders_sent:0, status:'pending', snoozed_until:null, acknowledged_at:null, acknowledged_by:null,
  completed_at:null, completed_by:null, deleted_at:null, created_at:new Date().toISOString(), updated_at:new Date().toISOString(),
  version:1, last_changed_by:PARTNER,
};
setState({ demoMode:true, user:{id:USER,email:'a@example.test'}, profile:{id:USER,display_name:'Ivan'}, pair:{id:PAIR,name:'I+D'}, members:[{id:USER,display_name:'Ivan'},{id:PARTNER,display_name:'Dominika'}], tasks:[task], booted:true, activeTab:'mine' });
showApp();

// Ivan otvorí detail úlohy (checkbox je z jeho pohľadu skrytý — úloha „pre mňa").
openTaskSheet(task);
assert.ok(document.getElementById('notifyCreatorWrap').hidden, 'Checkbox mal byť pre príjemcu skrytý');

// Ivan zmení názov a uloží (typická úprava — presne to spravil v reáli so zmenou času).
document.getElementById('fTitle').value = 'Uloha od partnera (upravena)';
document.getElementById('taskForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 150));

const saved = getState().tasks.find((t) => t.id === task.id);
assert.equal(saved?.title, 'Uloha od partnera (upravena)', 'Úprava sa neuložila');
assert.equal(saved?.notify_creator_on_complete, true, 'Úprava príjemcu ZMAZALA partnerovo „upozorni ma pri splnení"');

// Kontrola opačného smeru: nová úloha pre seba nesmie flag nastaviť.
openTaskSheet(null);
document.getElementById('fTitle').value = 'Nova uloha pre mna';
document.getElementById('fAssigned').value = USER;
document.getElementById('taskForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 150));
const created = getState().tasks.find((t) => t.title === 'Nova uloha pre mna');
assert.ok(created, 'Nová úloha sa nevytvorila');
assert.equal(created.notify_creator_on_complete, false, 'Nová úloha pre seba nemá mať notify flag');

await closeTaskService();
resetState();
console.log('NOTIFY FLAG PRESERVED OK');
process.exit(0);

import { getState, setState } from '../state/store.js';
import {
  createTask,
  updateTask,
  completeTask,
  acknowledgeTask,
  snoozeTask,
  deleteTask,
  rejectTask,
  hideTaskForSelf,
  fetchTasks,
  cachedTasks,
  flushOutbox,
  retryFailedOutbox,
  discardFailedOutbox,
} from '../services/task-service.js';
import {
  requestNotificationPermission,
  registerCurrentDevice,
  sendTestNotification,
  diagnostics,
  unregisterCurrentDevice,
  suspendDeviceRegistration,
} from '../services/notification-service.js';
import { signOut } from '../services/auth.js';
import { platform } from '../lib/platform.js';
import { withAbortTimeout } from '../lib/async.js';
import { localAlarmAllowed } from '../lib/reminders.js';

const SYNC_STEP_TIMEOUT_MS = 20_000;
const dom = {};
let selectedPriority = 1;
let selectedFiles = [];
let alarmTask = null;
let toastTimer = null;
let syncPromise = null;
let syncAgain = false;
let syncToastRequested = false;
let taskFormBusy = false;
let settingActionBusy = false;
let pendingNotificationTaskId = null;
const taskMutationBusy = new Set();
const shownAlarmAt = new Map();
const shownAlarmCount = new Map();

function $(id) { return document.getElementById(id); }
function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function memberById(id) { return getState().members.find((m) => m.id === id); }
function nameById(id) { return memberById(id)?.display_name || 'Neznámy'; }
function initials(name) { return String(name || '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase(); }
function isToday(date) {
  const d = new Date(date); const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
function isOverdue(task) { return task.status === 'pending' && !task.deleted_at && new Date(task.snoozed_until || task.due_at).getTime() < Date.now(); }
function effectiveDue(task) { return task.snoozed_until || task.due_at; }
function dueMs(task) { return new Date(effectiveDue(task)).getTime(); }
// Bezpečný prevod timestampu na ms — chýbajúca/neplatná hodnota radí nakoniec.
function tsMs(value) { const ms = new Date(value || 0).getTime(); return Number.isFinite(ms) ? ms : 0; }
function fmtDate(iso) { return new Intl.DateTimeFormat('sk-SK', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso)); }
function fmtTime(iso) { return new Intl.DateTimeFormat('sk-SK', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
function relativeTime(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff >= 0 ? 'o chvíľu' : 'práve mešká';
  if (abs < 3_600_000) return `${diff >= 0 ? 'o' : 'pred'} ${Math.round(abs / 60_000)} min`;
  if (abs < 86_400_000) return `${diff >= 0 ? 'o' : 'pred'} ${Math.round(abs / 3_600_000)} h`;
  return `${diff >= 0 ? 'o' : 'pred'} ${Math.round(abs / 86_400_000)} d`;
}
function localInputParts(iso) {
  const d = iso ? new Date(iso) : new Date(Date.now() + 60 * 60_000);
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
function inputToIso(date, time) { return new Date(`${date}T${time}:00`).toISOString(); }
// due_at sa počíta z lokálneho času ZARIADENIA – timezone stĺpec (recurrence
// wall-clock na serveri) mu musí zodpovedať, nie byť natvrdo Bratislava.
function deviceTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Bratislava'; }
  catch { return 'Europe/Bratislava'; }
}

export function bindUi() {
  Object.assign(dom, {
    loading: $('loadingScreen'), auth: $('authScreen'), app: $('app'), offline: $('offlineBanner'),
    main: $('main'), tabs: $('tabs'), dateLine: $('dateLine'), settingsBtn: $('settingsBtn'), addTaskBtn: $('addTaskBtn'),
    userName: $('userName'), userAvatar: $('userAvatar'), syncState: $('syncState'), scrim: $('scrim'), sheet: $('taskSheet'),
    form: $('taskForm'), title: $('fTitle'), note: $('fNote'), assigned: $('fAssigned'), notifyWrap: $('notifyCreatorWrap'), notifyCreator: $('fNotifyCreator'),
    date: $('fDate'), time: $('fTime'), countdown: $('fCountdown'), prio: $('fPrio'), pre: $('fPre'), rec: $('fRec'), recMode: $('fRecMode'), recModeWrap: $('fRecModeWrap'),
    interval: $('fInterval'), maxReminders: $('fMaxReminders'), files: $('fFiles'), addFiles: $('addFilesBtn'), attList: $('fAttList'), fileProgress: $('fileProgress'),
    deleteBtn: $('deleteTaskBtn'), closeSheetBtn: $('closeSheetBtn'), toast: $('toast'), alarmScrim: $('alarmScrim'), alarmTitle: $('alarmTitle'), alarmNote: $('alarmNote'),
    alarmOk: $('alarmOkBtn'), alarmDone: $('alarmDoneBtn'), alarmOpen: $('alarmOpenBtn'), snooze15: $('snooze15Btn'), snooze60: $('snooze60Btn'),
  });

  dom.settingsBtn.addEventListener('click', () => { setState({ activeTab: 'settings' }); render(); });
  dom.addTaskBtn.addEventListener('click', () => openTaskSheet());
  dom.scrim.addEventListener('click', closeTaskSheet);
  dom.closeSheetBtn.addEventListener('click', closeTaskSheet);
  dom.form.addEventListener('submit', saveTaskFromForm);
  dom.deleteBtn.addEventListener('click', deleteCurrentTask);
  dom.assigned.addEventListener('change', updateNotifyCreatorVisibility);
  dom.rec.addEventListener('change', () => { dom.recModeWrap.hidden = dom.rec.value === 'none'; });
  dom.date.addEventListener('input', updateCountdown);
  dom.time.addEventListener('input', updateCountdown);
  dom.prio.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-p]'); if (!btn) return;
    selectedPriority = Number(btn.dataset.p); dom.prio.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b === btn));
  });
  dom.addFiles.addEventListener('click', () => dom.files.click());
  dom.files.addEventListener('change', () => { selectedFiles.push(...dom.files.files); dom.files.value = ''; renderSelectedFiles(); });
  dom.attList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-file]'); if (!button) return;
    selectedFiles.splice(Number(button.dataset.removeFile), 1); renderSelectedFiles();
  });
  dom.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]'); if (!tab) return;
    setState({ activeTab: tab.dataset.tab }); render();
  });
  dom.main.addEventListener('click', handleMainClick);
  dom.alarmOk.addEventListener('click', () => handleAlarmAction('ack'));
  dom.alarmDone.addEventListener('click', () => handleAlarmAction('complete'));
  dom.snooze15.addEventListener('click', () => handleAlarmAction('snooze', 15));
  dom.snooze60.addEventListener('click', () => handleAlarmAction('snooze', 60));
  dom.alarmOpen.addEventListener('click', () => { const task = alarmTask; closeAlarm(); if (task) openTaskSheet(task); });

  window.addEventListener('online', async () => { dom.offline.hidden = true; await syncNow(); });
  window.addEventListener('offline', () => { dom.offline.hidden = false; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
  setInterval(checkDueAlarm, 30_000);
}

export function showLoading(show) { dom.loading.hidden = !show; }
export function showAuth(show, setupMessage = '') {
  dom.auth.hidden = !show; dom.app.hidden = show; $('setupHint').textContent = setupMessage;
}
export function showApp() { dom.auth.hidden = true; dom.app.hidden = false; dom.loading.hidden = true; render(); }

export function render() {
  const state = getState(); if (!state.user) return;
  dom.dateLine.textContent = new Intl.DateTimeFormat('sk-SK', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  dom.userName.textContent = state.profile?.display_name || state.user.email || 'Používateľ';
  dom.userAvatar.textContent = initials(state.profile?.display_name || state.user.email);
  dom.syncState.innerHTML = `${state.syncing ? '<span class="sync-dot pending"></span>synchronizujem' : state.syncError ? '<span class="sync-dot error"></span>chyba synchronizácie' : '<span class="sync-dot"></span>pripojené'}`;
  dom.offline.hidden = navigator.onLine;
  renderTabs();
  if (state.activeTab === 'settings') renderSettings(); else renderTaskList();
  checkDueAlarm();
}

function renderTabs() {
  const state = getState(); const tasks = state.tasks.filter((t) => !t.deleted_at);
  const partner = state.members.find((m) => m.id !== state.user.id);
  const tabs = [
    ['today', 'Dnes', tasks.filter((t) => t.status === 'pending' && isToday(effectiveDue(t))).length],
    ['mine', 'Moje', tasks.filter((t) => t.status === 'pending' && t.assigned_to === state.user.id).length],
    ['partner', partner?.display_name || 'Partner', tasks.filter((t) => t.status === 'pending' && t.assigned_to === partner?.id).length],
    ['missed', 'Zmeškané', tasks.filter(isOverdue).length],
    ['all', 'Všetky', tasks.filter((t) => t.status === 'pending').length],
    ['done', 'Hotové', tasks.filter((t) => t.status === 'completed').length],
    ['rejected', 'Odmietnuté', tasks.filter((t) => t.status === 'rejected').length],
  ];
  dom.tabs.innerHTML = tabs.map(([id, label, count]) => `<button class="tab ${state.activeTab === id ? 'active' : ''}" data-tab="${id}">${esc(label)}${count ? `<span class="badge">${count}</span>` : ''}</button>`).join('');
}

function filteredTasks() {
  const state = getState(); const partner = state.members.find((m) => m.id !== state.user.id);
  const tasks = state.tasks.filter((t) => !t.deleted_at);
  const filters = {
    today: (t) => t.status === 'pending' && isToday(effectiveDue(t)),
    mine: (t) => t.status === 'pending' && t.assigned_to === state.user.id,
    partner: (t) => t.status === 'pending' && t.assigned_to === partner?.id,
    missed: (t) => isOverdue(t),
    all: (t) => t.status === 'pending',
    done: (t) => t.status === 'completed',
    rejected: (t) => t.status === 'rejected',
  };
  return tasks.filter(filters[state.activeTab] || filters.today).sort((a, b) => {
    // Hotové/odmietnuté: najnovšie hore (podľa času splnenia / poslednej zmeny),
    // nie podľa termínu — inak by boli najstaršie úlohy navrchu.
    if (state.activeTab === 'done') return tsMs(b.completed_at || b.updated_at) - tsMs(a.completed_at || a.updated_at);
    if (state.activeTab === 'rejected') return tsMs(b.updated_at) - tsMs(a.updated_at);
    if (a.status === 'completed' && b.status !== 'completed') return 1;
    if (b.status === 'completed' && a.status !== 'completed') return -1;
    return dueMs(a) - dueMs(b);
  });
}

function renderTaskList() {
  const tasks = filteredTasks();
  if (!tasks.length) {
    dom.main.innerHTML = `<div class="empty"><div class="em">✓</div><h3>Žiadne úlohy</h3><p>V tejto časti momentálne nič nie je.</p></div>`;
    return;
  }
  dom.main.innerHTML = tasks.map(taskCard).join('');
}

function taskCard(task) {
  const state = getState(); const assignedName = nameById(task.assigned_to); const creatorName = nameById(task.created_by);
  const overdue = isOverdue(task); const completed = task.status === 'completed'; const mine = task.assigned_to === state.user.id;
  const ownerClass = assignedName.toLowerCase().includes('dominika') ? 'dominika' : '';
  const statusClass = completed ? 's-completed done-strike' : overdue ? 's-overdue' : task.snoozed_until ? 's-snoozed' : 's-active';
  const due = task.snoozed_until || task.due_at;
  const priority = Number(task.priority || 1);
  return `<article class="card ${statusClass} p${priority}" data-open-task="${esc(task.id)}">
    <button class="check ${completed ? 'checked' : ''}" ${mine && !completed ? `data-complete-task="${esc(task.id)}"` : 'disabled'} aria-label="${completed ? 'Splnené' : mine ? 'Označiť ako hotové' : 'Úlohu môže splniť jej vlastník'}"><svg viewBox="0 0 24 24"><polyline points="4,12 10,18 20,6"/></svg></button>
    <div class="c-body"><div class="c-title">${esc(task.title)}</div>${task.notes ? `<div class="c-note">${esc(task.notes)}</div>` : ''}
      <div class="c-meta"><span class="card-owner ${ownerClass}">Pre: ${esc(assignedName)}</span><span class="chip ${overdue ? 'late' : ''}">🕒 ${fmtDate(due)} ${fmtTime(due)}</span><span class="stars s${priority}">${'★'.repeat(priority)}</span>${task.snoozed_until ? '<span class="chip snz">Odložené</span>' : ''}</div>
      <div class="creator-line">Zadal/a: ${esc(creatorName)} · ${relativeTime(due)}${task.notify_creator_on_complete && task.created_by !== task.assigned_to ? ' · čaká na potvrdenie splnenia' : ''}</div>
      ${task.status === 'rejected' && task.rejection_reason ? `<div class="c-note reject-reason">Odmietnuté: ${esc(task.rejection_reason)}</div>` : ''}
      ${mine && task.status === 'pending' ? `<button type="button" class="link-btn" data-reject-task="${esc(task.id)}">Odmietnuť</button>` : ''}
      ${mine && task.status !== 'pending' ? `<button type="button" class="link-btn" data-hide-task="${esc(task.id)}">Odstrániť zo svojho zoznamu</button>` : ''}
    </div></article>`;
}

async function handleMainClick(event) {
  const complete = event.target.closest('[data-complete-task]');
  if (complete) { event.stopPropagation(); await mutateTask('complete', complete.dataset.completeTask); return; }
  const reject = event.target.closest('[data-reject-task]');
  if (reject) { event.stopPropagation(); await rejectTaskFromUi(reject.dataset.rejectTask); return; }
  const hide = event.target.closest('[data-hide-task]');
  if (hide) { event.stopPropagation(); await hideTaskFromUi(hide.dataset.hideTask); return; }
  const open = event.target.closest('[data-open-task]');
  if (open) {
    // Úloha mohla medzi renderom a klikom zmiznúť zo stavu (sync/hide na inom
    // zariadení) – vtedy neotváraj prázdny „Nová úloha" formulár.
    const found = getState().tasks.find((t) => t.id === open.dataset.openTask);
    if (found) openTaskSheet(found);
  }
  const action = event.target.closest('[data-setting-action]');
  if (action) await handleSettingAction(action.dataset.settingAction);
}

function translateTaskError(message) {
  const m = String(message || '');
  const map = {
    TASK_NOT_EDITABLE: 'Hotovú alebo zrušenú úlohu nemožno upraviť.',
    REJECTION_REASON_REQUIRED: 'Uveď dôvod odmietnutia.',
    REJECTION_REASON_TOO_LONG: 'Dôvod odmietnutia je príliš dlhý.',
    TASK_STILL_ACTIVE: 'Aktívnu úlohu nemožno odstrániť zo zoznamu.',
    ONLY_ASSIGNEE_CAN_REJECT: 'Odmietnuť môže iba príjemca úlohy.',
    TASK_CONFLICT: 'Úloha bola medzitým zmenená. Obnov ju a skús znova.',
    TASK_DELETED: 'Úloha už bola vymazaná.',
    TASK_NOT_FOUND: 'Úloha sa nenašla.',
    INVALID_ASSIGNEE: 'Neplatný príjemca úlohy.',
    INVALID_SNOOZE: 'Neplatný čas odloženia. Skús to znova.',
  };
  for (const [k, v] of Object.entries(map)) if (m.includes(k)) return v;
  return m;
}

// Issue 12: príjemca odmietne úlohu s povinným dôvodom.
// Busy guard ako pri mutateTask — dvojklik/pomalá sieť nesmie spustiť dve
// súbežné mutácie tej istej úlohy (druhá by skončila mätúcim TASK_CONFLICT).
async function rejectTaskFromUi(taskId) {
  if (taskMutationBusy.has(taskId)) return;
  const task = getState().tasks.find((t) => t.id === taskId); if (!task) return;
  const reason = window.prompt('Dôvod odmietnutia (povinný):', '');
  if (reason === null) return;
  if (!reason.trim()) { toast('Dôvod odmietnutia je povinný', true); return; }
  taskMutationBusy.add(taskId);
  try {
    await rejectTask(task, reason);
    await refreshFromCacheOrCloud();
    toast('Úloha odmietnutá');
  } catch (error) { toast(translateTaskError(error.message) || 'Odmietnutie zlyhalo', true); }
  finally { taskMutationBusy.delete(taskId); }
}

// Issue 12: príjemca odstráni terminálnu úlohu zo svojho zoznamu.
async function hideTaskFromUi(taskId) {
  if (taskMutationBusy.has(taskId)) return;
  const task = getState().tasks.find((t) => t.id === taskId); if (!task) return;
  taskMutationBusy.add(taskId);
  try {
    await hideTaskForSelf(task);
    await refreshFromCacheOrCloud();
    toast('Odstránené z tvojho zoznamu');
  } catch (error) { toast(translateTaskError(error.message) || 'Odstránenie zlyhalo', true); }
  finally { taskMutationBusy.delete(taskId); }
}

function renderSettings() {
  const state = getState(); const d = state.notificationStatus || {};
  dom.main.innerHTML = `<div class="settings-group"><h3>Účet a dvojica</h3><div class="diag-grid"><div class="diag-row"><span>Prihlásený</span><strong>${esc(state.profile?.display_name || state.user.email)}</strong></div><div class="diag-row"><span>Dvojica</span><strong>${esc(state.pair?.name || 'Ukážkový režim')}</strong></div><div class="diag-row"><span>Členovia</span><strong>${state.members.map((m) => esc(m.display_name)).join(' + ')}</strong></div></div></div>
  <div class="settings-group"><h3>Notifikácie</h3><div class="diag-grid"><div class="diag-row"><span>Platforma</span><strong>${esc(d.platform || platform.name)}</strong></div><div class="diag-row"><span>Natívna aplikácia</span><strong class="${d.native || d.webPush ? 'status-ok' : 'status-warn'}">${d.native ? 'Áno' : d.webPush ? 'Nie – web s podporou upozornení' : 'Nie – iba webový náhľad'}</strong></div><div class="diag-row"><span>OneSignal</span><strong class="${d.configured ? 'status-ok' : 'status-warn'}">${d.configured ? 'Nakonfigurovaný' : 'Čaká na App ID'}</strong></div><div class="diag-row"><span>Povolenie</span><strong>${esc(d.permission || 'nezistené')}</strong></div><div class="diag-row"><span>Subscription</span><strong class="${d.subscriptionId ? 'status-ok' : 'status-warn'}">${d.subscriptionId ? 'Aktívna' : 'Zatiaľ nevytvorená'}</strong></div></div></div>
  <div class="settings-group"><button class="secondary-btn" data-setting-action="permission">Zapnúť upozornenia</button><button class="secondary-btn" style="margin-top:9px" data-setting-action="test">Poslať testovaciu notifikáciu</button><button class="secondary-btn" style="margin-top:9px" data-setting-action="sync">Synchronizovať teraz</button></div>
  ${state.failedOutboxCount ? `<div class="settings-group"><h3>Nevyriešené offline zmeny</h3><div class="notice">${state.failedOutboxCount} zmien sa nepodarilo bezpečne zlúčiť s cloudom. Môžeš ich skúsiť znova alebo zahodiť a načítať aktuálny stav zo servera.</div><button class="secondary-btn" data-setting-action="retry-outbox">Skúsiť znova</button><button class="logout-btn" style="margin-top:9px" data-setting-action="discard-outbox">Zahodiť nevyriešené zmeny</button></div>` : ''}
  ${platform.isNative ? '' : `<div class="notice">Upozornenia fungujú aj vo webovej verzii. Na iPhone: pridaj appku na plochu (Safari → Zdieľať → Pridať na plochu), otvor ju z plochy a klikni „Zapnúť upozornenia".</div>`}
  <div class="settings-group"><button class="logout-btn" data-setting-action="logout">Odhlásiť sa</button></div>`;
}

async function handleSettingAction(action) {
  if (settingActionBusy) return;
  settingActionBusy = true;
  try {
    if (action === 'permission') {
      const result = await requestNotificationPermission();
      if (!result.accepted || !result.subscriptionId) throw new Error('Upozornenia neboli povolené alebo sa nevytvorila push subscription.');
      await registerCurrentDevice();
      setState({ notificationStatus: await diagnostics() });
      toast('Upozornenia sú nastavené');
    }
    if (action === 'test') { await sendTestNotification(); toast('Test bol zaradený na odoslanie'); }
    if (action === 'sync') await syncNow(true);
    if (action === 'retry-outbox') { await retryFailedOutbox(); await syncNow(true); }
    if (action === 'discard-outbox') {
      if (!confirm('Zahodiť nevyriešené offline zmeny a načítať stav zo servera?')) return;
      await discardFailedOutbox();
      await syncNow(true);
    }
    if (action === 'logout') {
      if (getState().demoMode) location.reload();
      else {
        if (platform.isNative && !navigator.onLine) throw new Error('Pred odhlásením sa pripoj na internet, aby sa telefón bezpečne odpojil od účtu.');
        // OneSignal subscription-change event nesmie zariadenie počas
        // odhlasovania znova zaregistrovať (okno unregister -> signOut).
        suspendDeviceRegistration();
        await unregisterCurrentDevice();
        await signOut();
      }
    }
  } catch (error) { toast(error.message || 'Operácia zlyhala', true); }
  finally { settingActionBusy = false; }
  render();
}

export function openTaskSheet(task = null) {
  // Issue 8: otvorenie detailu úlohy (napr. z notifikácie) zavrie prípadný
  // budík, aby sa nezobrazil natívny + in-app alarm pre tú istú úlohu naraz.
  closeAlarm();
  const state = getState(); setState({ editingTaskId: task?.id || null }); selectedFiles = []; selectedPriority = Number(task?.priority || 1);
  const terminal = Boolean(task) && task.status !== 'pending';
  $('sheetTitle').textContent = !task ? 'Nová úloha' : (terminal ? 'Detail úlohy' : 'Upraviť úlohu');
  dom.assigned.innerHTML = state.members.map((m) => `<option value="${esc(m.id)}">${esc(m.id === state.user.id ? 'Mne – ' + m.display_name : m.display_name)}</option>`).join('');
  dom.title.value = task?.title || ''; dom.note.value = task?.notes || ''; dom.assigned.value = task?.assigned_to || state.user.id;
  const parts = localInputParts(task?.due_at); dom.date.value = parts.date; dom.time.value = parts.time;
  dom.pre.value = String(task?.pre_reminder_minutes ?? 0); dom.rec.value = task?.recurrence_rule || 'none'; dom.recMode.value = task?.recurrence_mode || 'after'; dom.recModeWrap.hidden = dom.rec.value === 'none';
  dom.interval.value = String(task?.reminder_interval_seconds || 60); dom.maxReminders.value = String(task?.max_reminders || 10); dom.notifyCreator.checked = Boolean(task?.notify_creator_on_complete);
  dom.prio.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', Number(b.dataset.p) === selectedPriority));
  dom.deleteBtn.hidden = !task; renderSelectedFiles(); updateNotifyCreatorVisibility(); updateCountdown();
  // Issue 3: terminálnu úlohu možno len prezerať – zakáž úpravu polí a uloženie.
  [dom.title, dom.note, dom.assigned, dom.date, dom.time, dom.pre, dom.rec, dom.recMode, dom.interval, dom.maxReminders, dom.notifyCreator]
    .forEach((el) => { if (el) el.disabled = terminal; });
  const saveBtn = dom.form.querySelector('button[type="submit"]');
  if (saveBtn) { saveBtn.disabled = terminal; saveBtn.hidden = terminal; }
  dom.scrim.classList.add('show'); dom.sheet.classList.add('show'); setTimeout(() => dom.title.focus(), 200);
}

function closeTaskSheet() { dom.scrim.classList.remove('show'); dom.sheet.classList.remove('show'); setState({ editingTaskId: null }); }
// Checkbox „upozorni ma pri splnení" sa skrýva pri úlohe pre seba — ale NESMIE
// pri skrytí mazať hodnotu: keď PRÍJEMCA edituje úlohu od partnera, checkbox je
// z jeho pohľadu skrytý a vynulovanie by potichu zmazalo partnerovo prianie
// (bug: Dominika zaškrtla, Ivan upravil čas → upozornenie zmizlo).
function updateNotifyCreatorVisibility() { dom.notifyWrap.hidden = dom.assigned.value === getState().user.id; }
function updateCountdown() { if (!dom.date.value || !dom.time.value) return; dom.countdown.textContent = relativeTime(inputToIso(dom.date.value, dom.time.value)); }
function renderSelectedFiles() { dom.attList.innerHTML = selectedFiles.map((file, i) => `<div class="att-item"><span class="att-icon">${file.type.startsWith('image/') ? '🖼️' : '📄'}</span><div class="att-name">${esc(file.name)}<div class="att-size">${Math.ceil(file.size / 1024)} KB</div></div><button type="button" class="att-del" data-remove-file="${i}">×</button></div>`).join(''); dom.fileProgress.textContent = selectedFiles.length ? `${selectedFiles.length} príloh pripravených na uloženie` : ''; }

async function saveTaskFromForm(event) {
  event.preventDefault();
  if (taskFormBusy) return;
  taskFormBusy = true;
  const saveButton = dom.form.querySelector('button[type="submit"]');
  if (saveButton) saveButton.disabled = true;
  const state = getState(); const editing = state.tasks.find((t) => t.id === state.editingTaskId);
  try {
    // Issue 3: terminálnu úlohu nemožno upraviť (poistka aj na klientovi).
    if (editing && editing.status !== 'pending') {
      toast('Hotovú alebo zrušenú úlohu nemožno upraviť', true);
      return;
    }
    // Skrytý checkbox (úloha pre seba z pohľadu editora) = editor ho nemôže
    // meniť → pri úprave zachovaj pôvodnú hodnotu (prianie tvorcu), pri novej
    // úlohe false. Viditeľný checkbox platí tak, ako je zaškrtnutý.
    const notifyCreator = dom.notifyWrap.hidden ? Boolean(editing?.notify_creator_on_complete ?? false) : dom.notifyCreator.checked;
    const input = { title: dom.title.value.trim(), notes: dom.note.value.trim(), assigned_to: dom.assigned.value, due_at: inputToIso(dom.date.value, dom.time.value), timezone: editing?.timezone || deviceTimezone(), priority: selectedPriority, pre_reminder_minutes: Number(dom.pre.value), recurrence_rule: dom.rec.value, recurrence_mode: dom.recMode.value, notify_creator_on_complete: notifyCreator, reminder_interval_seconds: Number(dom.interval.value), max_reminders: Number(dom.maxReminders.value) };
    if (!input.title) {
      toast('Napíš názov úlohy', true);
      return;
    }
    dom.fileProgress.textContent = 'Ukladám…';
    const result = editing ? await updateTask(editing, input, selectedFiles) : await createTask(input, selectedFiles);
    await refreshFromCacheOrCloud();
    closeTaskSheet();
    if (result.attachmentErrors?.length) toast(`Úloha je uložená, ale ${result.attachmentErrors.length} príloh sa nepodarilo nahrať`, true);
    else if (result.attachmentsSkipped) toast(`Uložené offline – ${result.attachmentsSkipped} príloh sa NEnahralo, pridaj ich po pripojení znova`, true);
    else toast(result.queued ? 'Uložené offline – čaká na synchronizáciu' : 'Úloha uložená');
  } catch (error) { dom.fileProgress.textContent = ''; toast(translateTaskError(error.message) || 'Uloženie zlyhalo', true); }
  finally {
    taskFormBusy = false;
    if (saveButton) saveButton.disabled = false;
  }
}

async function deleteCurrentTask() {
  if (taskFormBusy) return;
  const task = getState().tasks.find((t) => t.id === getState().editingTaskId); if (!task) return;
  if (!confirm(`Vymazať úlohu „${task.title}“?`)) return;
  taskFormBusy = true;
  dom.deleteBtn.disabled = true;
  try { const result = await deleteTask(task); await refreshFromCacheOrCloud(); closeTaskSheet(); toast(result.queued ? 'Vymazanie čaká na synchronizáciu' : 'Úloha bola vymazaná'); } catch (error) { toast(error.message, true); }
  finally { taskFormBusy = false; dom.deleteBtn.disabled = false; }
}

async function mutateTask(action, id, value = null) {
  if (taskMutationBusy.has(id)) return;
  const task = getState().tasks.find((t) => t.id === id); if (!task) return;
  taskMutationBusy.add(id);
  try {
    // Explicitné vetvy: pred opravou každá neznáma akcia (napr. 'done' z alarmu)
    // potichu spadla do snoozeTask(task, undefined) a server vrátil INVALID_SNOOZE.
    let result;
    if (action === 'complete') result = await completeTask(task);
    else if (action === 'ack') result = await acknowledgeTask(task);
    else if (action === 'snooze') {
      const minutes = Number(value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error('INVALID_SNOOZE');
      result = await snoozeTask(task, minutes);
    } else throw new Error(`Neznáma akcia úlohy: ${action}`);
    await refreshFromCacheOrCloud(); toast(result.queued ? 'Zmena čaká na internet' : action === 'complete' ? 'Úloha splnená' : action === 'ack' ? 'Pripomínanie zastavené' : `Odložené o ${value} min`);
  } catch (error) { toast(translateTaskError(error.message) || 'Zmena zlyhala', true); }
  finally { taskMutationBusy.delete(id); }
}

async function refreshFromCacheOrCloud() {
  const state = getState();
  if (!state.demoMode && navigator.onLine) {
    await syncNow();
    return;
  }
  const tasks = await fetchTasks();
  setState({ tasks, syncError: null });
  render();
}

async function performSync(showToast) {
  const state = getState();
  if (!state.user || state.demoMode || !navigator.onLine) return;
  const userId = state.user.id;
  setState({ syncing: true });
  render();
  try {
    const outbox = await withAbortTimeout((signal) => flushOutbox(signal), { timeoutMs: SYNC_STEP_TIMEOUT_MS, message: 'Synchronizácia trvá príliš dlho.' });
    if (getState().user?.id !== userId) return;
    const tasks = await withAbortTimeout((signal) => fetchTasks(signal), { timeoutMs: SYNC_STEP_TIMEOUT_MS, message: 'Načítanie úloh trvá príliš dlho.' });
    if (getState().user?.id !== userId) return;
    const syncError = outbox.unresolved ? `${outbox.unresolved} offline zmien vyžaduje kontrolu` : null;
    setState({ tasks, syncing: false, syncError, failedOutboxCount: outbox.unresolved || 0 });
    if (showToast) toast(syncError || 'Synchronizácia dokončená', Boolean(syncError));
  } catch (error) {
    if (getState().user?.id !== userId) return;
    // „Online, ale sieť nefunguje": optimistická zmena je už v lokálnej DB,
    // no fetchTasks zlyhal. Bez načítania cache by UI ukazovalo starý stav
    // a používateľ by mutáciu zopakoval (duplicitne).
    const fallback = await cachedTasks().catch(() => null);
    if (getState().user?.id !== userId) return;
    setState({ ...(fallback ? { tasks: fallback } : {}), syncing: false, syncError: error.message });
    if (showToast) toast('Synchronizácia zlyhala', true);
  }
  if (getState().user?.id === userId) render();
}

export async function syncNow(showToast = false) {
  syncToastRequested ||= showToast;
  if (syncPromise) {
    syncAgain = true;
    return syncPromise;
  }

  syncPromise = (async () => {
    do {
      syncAgain = false;
      const shouldToast = syncToastRequested;
      syncToastRequested = false;
      await performSync(shouldToast);
    } while (syncAgain);
  })().finally(() => { syncPromise = null; });

  return syncPromise;
}

function checkDueAlarm() {
  const state = getState(); if (!state.user || alarmTask) return;
  // Issue 8: keď je otvorený detail úlohy, in-app budík nevyskakuj (zabráni dvojici).
  if (dom.sheet?.classList.contains('show')) return;
  const now = Date.now();
  const task = state.tasks.find((t) => {
    const alarmKey = `${t.id}:${t.version}:${effectiveDue(t)}`;
    return localAlarmAllowed(t, {
      userId: state.user.id,
      now,
      dueMs: dueMs(t),
      lastShownAt: shownAlarmAt.get(alarmKey) || 0,
      shownCount: shownAlarmCount.get(alarmKey) || 0,
    });
  });
  if (!task) return;
  markAlarmShown(task, now);
  showAlarmForTask(task);
}
// Zaúčtovanie zobrazenia alarmu (interval gate + rozpočet max_reminders).
// Volá sa z checkDueAlarm AJ z kliku na push notifikáciu, aby sa alarm
// nezobrazoval dvojmo a zobrazenia sa počítali jednotne.
function markAlarmShown(task, now = Date.now()) {
  const alarmKey = `${task.id}:${task.version}:${effectiveDue(task)}`;
  // Map.set na existujúci kľúč NEobnovuje poradie vloženia – živý kľúč treba
  // presunúť na koniec, inak by ho eviction nižšie vyhodil ako „najstarší"
  // a vynuloval jeho počítadlo pripomienok.
  const nextCount = (shownAlarmCount.get(alarmKey) || 0) + 1;
  shownAlarmAt.delete(alarmKey);
  shownAlarmCount.delete(alarmKey);
  shownAlarmAt.set(alarmKey, now);
  shownAlarmCount.set(alarmKey, nextCount);
  // Dlhodobo otvorená aplikácia nesmie hromadiť neobmedzenú históriu.
  if (shownAlarmAt.size > 500) {
    const oldest = shownAlarmAt.keys().next().value;
    shownAlarmAt.delete(oldest);
    shownAlarmCount.delete(oldest);
  }
}
// Zobrazenie alarmového okna (Hotovo / OK — počul som / Odložiť / Otvoriť úlohu)
// pre konkrétnu úlohu. Prípadný otvorený formulár sa zavrie — alarm má prednosť.
function showAlarmForTask(task) {
  closeTaskSheet();
  alarmTask = task;
  dom.alarmTitle.textContent = task.title;
  dom.alarmNote.textContent = task.notes || `${fmtDate(effectiveDue(task))} ${fmtTime(effectiveDue(task))}`;
  dom.alarmScrim.classList.add('show');
}
function closeAlarm() { dom.alarmScrim.classList.remove('show'); alarmTask = null; }
async function handleAlarmAction(action, minutes) { if (!alarmTask) return; const id = alarmTask.id; closeAlarm(); await mutateTask(action, id, minutes); }

export function openTaskFromNotification(taskId) {
  if (!taskId) return;
  if (!getState().user) {
    pendingNotificationTaskId = taskId;
    return;
  }
  // Klik na push pripomienky má položiť otázku „Hotovo / nechať / odložiť?"
  // (alarmové okno), NIE otvoriť editačný formulár s klávesnicou. Alarm ale
  // LEN pre už splatnú úlohu: push „nová úloha od partnera" chodí hneď pri
  // vytvorení — alarm na nesplatnej úlohe by cez „OK — počul som" potichu
  // vypol všetky budúce pripomienky (acknowledged_at) a „Odložiť 15 min" by
  // presunul termín DOPREDU. Nesplatné/splnené/partnerove → detail.
  const open = (task) => {
    if (task.status === 'pending' && task.assigned_to === getState().user.id && dueMs(task) <= Date.now()) {
      markAlarmShown(task);
      showAlarmForTask(task);
    } else openTaskSheet(task);
  };
  const task = getState().tasks.find((t) => t.id === taskId);
  if (task) open(task);
  else syncNow().then(() => {
    const refreshed = getState().tasks.find((t) => t.id === taskId);
    if (refreshed) open(refreshed);
  }).catch((error) => console.warn('Notification task open failed', error));
}

export function processPendingNotification() {
  const taskId = pendingNotificationTaskId;
  pendingNotificationTaskId = null;
  if (taskId) openTaskFromNotification(taskId);
}

export function resetTransientUi() {
  selectedFiles = [];
  alarmTask = null;
  pendingNotificationTaskId = null;
  shownAlarmAt.clear();
  shownAlarmCount.clear();
  taskMutationBusy.clear();
  taskFormBusy = false;
  settingActionBusy = false;
  dom.scrim?.classList.remove('show');
  dom.sheet?.classList.remove('show');
  dom.alarmScrim?.classList.remove('show');
}

export function toast(message, error = false) {
  clearTimeout(toastTimer); dom.toast.textContent = message; dom.toast.style.background = error ? '#7f1d1d' : ''; dom.toast.classList.add('show');
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 3000);
}

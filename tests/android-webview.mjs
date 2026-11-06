import { bindUi, showApp, render, resetTransientUi, showForegroundReminder, openTaskFromNotification, openTaskSheet } from '../src/ui/app-ui.js';
import { setState } from '../src/state/store.js';
import * as svc from '../src/services/task-service.js';
import { __setSupabaseForTests } from '../src/lib/supabase.js';
import { handleForegroundWillDisplay } from '../src/services/notification-service.js';
import { readBackendSchema } from '../src/lib/backend-capabilities.js';
import { runGroupScenarios } from './group-ui-scenarios.mjs';

const checks = [];
function check(condition, name) { if (!condition) throw new Error(name); checks.push(name); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function screenshot(name) {
  window.__androidCheckpoint=name;
  window.__androidContinue=false;
  // UiAutomation may wait for renderer idleness before taking a screenshot.
  for(let i=0;i<600 && !window.__androidContinue;i++) await wait(100);
  if(!window.__androidContinue) throw new Error('Instrumentation did not capture '+name);
}
async function run() {
  // No cloud requests, push registration or real user data during instrumentation.
  window.fetch = async () => { throw new Error('Network disabled in Android regression fixture'); };
  const USER=crypto.randomUUID(), PAIR='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const base={id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',pair_id:PAIR,created_by:USER,assigned_to:USER,
    title:'Android test – pripomienka',notes:'',due_at:new Date(Date.now()-60000).toISOString(),timezone:'Europe/Bratislava',
    status:'pending',priority:1,recurrence_rule:'none',recurrence_mode:'after',pre_reminder_minutes:0,
    max_reminders:1,reminders_sent:1,reminder_interval_seconds:60,version:1};
  await svc.initTaskService({userId:USER,pairId:PAIR,demoMode:true});
  bindUi();
  setState({user:{id:USER},profile:{display_name:'Testovací používateľ'},pair:{id:PAIR,name:'Test'},members:[{id:USER,display_name:'Testovací používateľ'}],tasks:[base],demoMode:true,booted:true});
  showApp();
  let suppressed=false;
  const event=()=>({notification:{additionalData:{task_id:base.id,kind:'task_due'}},preventDefault:()=>{suppressed=true;}});
  handleForegroundWillDisplay(event(), ({taskId,kind})=>showForegroundReminder(taskId,kind));
  check(suppressed && document.getElementById('alarmScrim').classList.contains('show'),'foreground last reminder displayed');
  await screenshot('foreground-alarm');
  await svc.cacheTasks([base]);
  document.getElementById('alarmDoneBtn').click();
  await wait(200);
  check((await svc.cachedTasks()).find(t=>t.id===base.id)?.status==='completed','alarm Done completes task in real IndexedDB');
  resetTransientUi();
  const future={...base,id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',due_at:new Date(Date.now()+3600000).toISOString()};
  setState({tasks:[base,future]});
  openTaskFromNotification(future.id);
  document.getElementById('fTitle').value='Rozpísaná úloha';
  suppressed=false;
  handleForegroundWillDisplay(event(), ({taskId,kind})=>showForegroundReminder(taskId,kind));
  check(!suppressed && document.getElementById('fTitle').value==='Rozpísaná úloha','editor keeps draft and native fallback');
  resetTransientUi();
  await svc.closeTaskService();
  let online=true;
  Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>online});
  let server={...base,reminders_sent:0,max_reminders:10};
  let rpcError=null;
  function builder(data) { const b={select:()=>b,eq:()=>b,order:()=>Promise.resolve({data,error:null}),then:(ok,err)=>Promise.resolve({data,error:null}).then(ok,err)}; return b; }
  __setSupabaseForTests({from:table=>builder(table==='tasks'?[server]:[]),rpc:async()=>({data:null,error:rpcError})});
  await svc.initTaskService({userId:USER,pairId:PAIR,demoMode:false});
  await svc.fetchTasks();
  online=false;
  const first=await svc.updateTask(server,{...server,title:'Offline 1'});
  await svc.updateTask(first.task,{...first.task,title:'Offline 2'});
  online=true;
  rpcError={status:500,message:'simulated server unavailable'};
  await svc.flushOutbox();
  check((await svc.fetchTasks())[0].title==='Offline 2','offline edits survive transient server failure');
  server={...server,status:'completed',version:2};
  rpcError={message:'TASK_CONFLICT'};
  await svc.flushOutbox();
  const merged=await svc.fetchTasks();
  setState({tasks:merged,activeTab:'done'}); render();
  await wait(200);
  check(merged[0].status==='completed' && document.querySelector('[data-tab="done"].active') && document.getElementById('main').textContent.includes(base.title),'server completion wins over two local edits and renders in Done tab');
  check((await svc.failedOutboxItems()).length===2,'conflicting edits retained for resolution');
  await svc.closeTaskService();
  let timeout=false;
  try { await readBackendSchema({rpc:()=>({abortSignal:()=>new Promise(()=>{})})},30); } catch(error) { timeout=error.code==='TIMEOUT'; }
  check(timeout,'hung request times out on Android');
  await screenshot('completed-after-conflict');
  checks.push(...await runGroupScenarios());
  await wait(200);
  await screenshot('three-members');
  await svc.closeTaskService();
  checks.push(...await runLongTaskAndReplyScenarios(USER, PAIR, base));
  await svc.closeTaskService();
  return {ok:true,checks};
}

// 1.0.20: veľmi dlhá úloha v budíku (tlačidlá museli zmiznúť pod okraj, z budíka
// sa nedalo odísť) a odpoveď na úlohu (1.0.19) v skutočnom Android WebView.
async function runLongTaskAndReplyScenarios(USER, PAIR, base) {
  const results = []; const ok = (condition, name) => { if (!condition) throw new Error(name); results.push(name); };
  const $ = id => document.getElementById(id);
  const IVAN = crypto.randomUUID();
  const members = [{ id: USER, display_name: 'Ivka' }, { id: IVAN, display_name: 'Ivan' }];
  const longNote = Array.from({ length: 12 }, (_, i) => `${i + 1}. Úprava skrine a chodby podľa fotografie – zachovaj proporcie pôvodnej zostavy, dvierka sa musia dať otvárať bez kolízie s klimatizáciou.`).join(' ');
  const longTask = { ...base, id: crypto.randomUUID(), created_by: IVAN, assigned_to: USER, title: 'Dať fotky skrine do Claude a zadať úpravy chodby',
    notes: longNote, due_at: new Date(Date.now() - 60000).toISOString(), reminders_sent: 0, max_reminders: 10, created_at: new Date(Date.now() - 86400000).toISOString() };
  await svc.initTaskService({ userId: USER, pairId: PAIR, demoMode: true });
  await svc.cacheTasks([longTask]);
  setState({ user: { id: USER }, profile: members[0], pair: { id: PAIR, name: 'Test' }, members, tasks: [longTask], demoMode: true, booted: true, activeTab: 'all' });
  showApp();
  // Ako u Ivana: klik na upozornenie splatnej úlohy otvorí budík.
  openTaskFromNotification(longTask.id);
  await wait(500);
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:0;padding-bottom:var(--safe-bot)';
  document.body.appendChild(probe);
  const safeBottom = probe.getBoundingClientRect().height; probe.remove();
  const onScreen = id => { const r = $(id).getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight - safeBottom + 1; };
  const content = $('alarmContent');
  ok($('alarmScrim').classList.contains('show') && ['alarmOkBtn', 'snooze15Btn', 'alarmDoneBtn', 'alarmOpenBtn'].every(onScreen) && content.scrollHeight > content.clientHeight,
    'long task alarm keeps all buttons on screen and scrolls its text');
  await screenshot('long-task-alarm');
  content.scrollTop = content.scrollHeight;
  await wait(100);
  const scrolled = content.scrollTop > 0;
  $('alarmOpenBtn').click();
  await wait(500);
  ok(scrolled && $('taskSheet').classList.contains('show') && !$('alarmScrim').classList.contains('show') && $('fNote').clientHeight > 120,
    'long alarm text scrolls and Open task leaves the alarm with a readable note');
  await screenshot('long-task-detail');
  $('closeSheetBtn').click();
  await wait(300);
  // Odpoveď na úlohu: Ivka posunie dlhú úlohu Ivanovi.
  const reply = document.querySelector(`[data-reply-task="${longTask.id}"]`);
  reply.click();
  await wait(400);
  $('fNote').value = 'Opravár príde len so súhlasom majiteľa bytu. Zavolaj mu prosím, potom ho objednám.';
  ok($('sheetTitle').textContent.includes('Odpovedať') && $('fAssigned').value === IVAN && !$('fThread').hidden, 'reply form defaults to the assigner and shows the genesis');
  await screenshot('reply-form');
  $('taskForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  let child;
  for (let i = 0; i < 100; i++) { child = (await svc.cachedTasks()).find(t => t.parent_task_id === longTask.id); if (child && !$('taskSheet').classList.contains('show')) break; await wait(30); }
  const original = (await svc.cachedTasks()).find(t => t.id === longTask.id);
  setState({ tasks: await svc.cachedTasks() });
  openTaskSheet(child);
  await wait(400);
  const clamped = document.querySelector('#fThread .ts-note.clamp');
  const sheetAtTop = $('taskSheet').scrollTop === 0 && !$('taskSheet').contains(document.activeElement);
  await screenshot('reply-genesis');
  const collapsedHeight = clamped?.getBoundingClientRect().height || 0;
  document.querySelector('#fThread .ts-more')?.click();
  await wait(100);
  ok(original?.status === 'handed_off' && child?.assigned_to === IVAN && child?.thread_id === longTask.id && document.querySelectorAll('#fThread .thread-step').length === 2
    && sheetAtTop && clamped && clamped.classList.contains('open') && clamped.getBoundingClientRect().height > collapsedHeight,
    'reply closes the original as handed off; detail opens at the top with a collapsible long genesis note');
  $('closeSheetBtn').click();
  return results;
}
run().then(result=>{window.__androidReview=result;}).catch(error=>{window.__androidReview={ok:false,checks,error:String(error.stack||error)};});

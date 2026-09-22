import { bindUi, showApp, render, resetTransientUi, showForegroundReminder, openTaskFromNotification } from '../src/ui/app-ui.js';
import { setState } from '../src/state/store.js';
import * as svc from '../src/services/task-service.js';
import { __setSupabaseForTests } from '../src/lib/supabase.js';
import { handleForegroundWillDisplay } from '../src/services/notification-service.js';
import { readBackendSchema } from '../src/lib/backend-capabilities.js';

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
  return {ok:true,checks};
}
run().then(result=>{window.__androidReview=result;}).catch(error=>{window.__androidReview={ok:false,checks,error:String(error.stack||error)};});

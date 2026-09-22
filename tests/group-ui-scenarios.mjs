import { __setSupabaseForTests } from '../src/lib/supabase.js';
import { setState } from '../src/state/store.js';
import { openGroupDialog, closeGroupDialog } from '../src/ui/group-ui.js';
import { createInvitation, acceptInvitation } from '../src/services/group-service.js';
import { loadIdentity } from '../src/services/profile-service.js';
import { showApp } from '../src/ui/app-ui.js';
import * as svc from '../src/services/task-service.js';
import { selectPartnerId } from '../supabase/functions/chatgpt-api/partner.js';
import { bindMembershipAuth, showJoinGroup, resetMembershipAuth } from '../src/ui/membership-auth-ui.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const $=id=>document.getElementById(id);
export async function runGroupScenarios() {
  const results=[]; const check=(ok,name)=>{if(!ok)throw new Error(name);results.push(name);};
  const A=crypto.randomUUID(),B=crypto.randomUUID(),C=crypto.randomUUID(),P=crypto.randomUUID();
  const members=[{id:A,display_name:'Test A'},{id:B,display_name:'Test B'},{id:C,display_name:'Test C'}];
  let created=null,missing=false;
  __setSupabaseForTests({
    from(table) {
      const rows=table==='pair_members'?members.map(m=>({user_id:m.id})):members;
      const b={select:()=>b,eq:()=>b,order:async()=>({data:rows,error:null}),in:async()=>({data:members,error:null}),
        maybeSingle:async()=>({data:missing?null:{pair_id:P,role:'owner'},error:null}),
        single:async()=>({data:table==='pairs'?{id:P,name:'Test group'}:members[0],error:null})}; return b;
    },
    rpc(name,args) {
      let data=[];
      if(name==='create_group_invitation') {created=args;data={id:crypto.randomUUID(),email:args.p_email,expires_at:new Date(Date.now()+86400000).toISOString()};}
      if(name==='accept_group_invitation')data=P;
      return {abortSignal:async()=>({data,error:null})};
    },
  });
  setState({user:{id:A},profile:members[0],pair:{id:P,name:'Test group'},members,membershipRole:'owner',demoMode:false,tasks:[]});
  await openGroupDialog();
  if($('groupInviteForm').hidden)throw new Error('Owner invite form missing');
  let rejected=false;try{await createInvitation('new@example.test',false);}catch{rejected=true;}
  $('inviteEmail').value='new@example.test';$('inviteShareAll').checked=true;
  $('groupInviteForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  for(let i=0;i<100 && !$('inviteCode').value;i++)await wait(20);
  const code=$('inviteCode').value;
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code))),b=>b.toString(16).padStart(2,'0')).join('');
  check(rejected && /^[0-9a-f]{64}$/.test(code) && created?.p_token_hash===digest && !JSON.stringify(created).includes(code),'owner invitation requires confirmation and sends only hash');
  const joined=await acceptInvitation(code,'Test C',true);closeGroupDialog();
  check(joined===P && !$('inviteCode').value && $('groupDialog').hidden,'join RPC and clearing invitation code on close');
  let registrations=0,joinedUser=null,joinCalls=0;
  bindMembershipAuth(session=>{joinedUser=session.user.id;joinCalls++;},{signUp:async()=>{registrations++;return {session:null};},getSession:async()=>({user:{id:C}}),signOut:async()=>{}});
  $('registerEmail').value='new@example.test';$('registerPassword').value='synthetic-test-only-password';
  $('registerForm').dispatchEvent(new Event('submit',{cancelable:true}));
  $('registerForm').dispatchEvent(new Event('submit',{cancelable:true}));
  await wait(50);
  check(registrations===1 && !$('registerPassword').value && $('registerMessage').textContent.includes('potvrď'),'registration double-submit guard and password cleared');
  showJoinGroup({id:C,email:'new@example.test'});
  $('joinName').value='Test C';$('joinCode').value=code;$('joinShareAll').checked=true;
  $('joinGroupForm').dispatchEvent(new Event('submit',{cancelable:true}));
  $('joinGroupForm').dispatchEvent(new Event('submit',{cancelable:true}));
  for(let i=0;i<100&&!joinedUser;i++)await wait(20);
  check(joinedUser===C && joinCalls===1 && !$('joinCode').value && $('loginForm').hidden,'new member join form uses own session and guards double submit');
  resetMembershipAuth();
  missing=true;let noMembership=false;try{await loadIdentity(A);}catch(error){noMembership=error.code==='NO_MEMBERSHIP';}missing=false;
  check(noMembership && selectPartnerId([C,A,B],A,B)===B && selectPartnerId([A,B,C],A,null)===null && selectPartnerId([A,B,C],A,'outsider')===null,'new account onboarding and stable ChatGPT partner');
  await svc.initTaskService({userId:A,pairId:P,demoMode:true});
  const task=(who,title)=>({id:crypto.randomUUID(),pair_id:P,created_by:A,assigned_to:who,title,notes:'',status:'pending',due_at:new Date(Date.now()+3600000).toISOString(),timezone:'Europe/Bratislava',priority:1,version:1,recurrence_rule:'none',recurrence_mode:'after',pre_reminder_minutes:0,reminder_interval_seconds:60,max_reminders:10,reminders_sent:0});
  const tasks=[task(B,'Existing shared task'),task(C,'Third member task')];await svc.cacheTasks(tasks);
  setState({demoMode:true,tasks,activeTab:'all'});showApp();
  check($('fAssigned') && document.querySelector(`[data-tab="member:${C}"]`) && document.querySelector('[data-tab="partner"]').textContent.includes('Test B'),'separate recipient tabs for all members');
  document.querySelector(`[data-tab="member:${C}"]`).click();
  const onlyThird=$('main').textContent.includes('Third member task')&&!$('main').textContent.includes('Existing shared task');
  document.querySelector('[data-tab="all"]').click();
  check(onlyThird && $('main').textContent.includes('Existing shared task') && $('main').textContent.includes('Third member task'),'member filter and shared task list');
  $('addTaskBtn').click();$('fTitle').value='New task for third member';$('fAssigned').value=C;
  $('fAssigned').dispatchEvent(new Event('change'));$('fNotifyCreator').checked=true;
  $('taskForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  let saved;
  for(let i=0;i<100;i++){saved=(await svc.cachedTasks()).find(t=>t.title==='New task for third member');if(saved && !$('taskSheet').classList.contains('show'))break;await wait(20);}
  check(saved?.assigned_to===C && saved?.notify_creator_on_complete===true && !$('taskSheet').classList.contains('show') && $('main').textContent.includes(saved.title),'create task for third member with completion notification');
  await svc.closeTaskService();
  return results;
}

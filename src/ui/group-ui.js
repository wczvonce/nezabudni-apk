import { getState, setState } from '../state/store.js';
import { loadIdentity } from '../services/profile-service.js';
import { createInvitation, listInvitations, revokeInvitation } from '../services/group-service.js';
import { withAbortTimeout } from '../lib/async.js';

let generation = 0;
let busy = false;
let membersChanged = () => {};
const $ = id => document.getElementById(id);
export function closeGroupDialog() {
  generation++;
  $('groupDialog').hidden=true;
  $('groupInviteForm').reset();
  $('groupInviteForm').hidden=true;
  $('inviteCode').value='';
  $('inviteResult').hidden=true;
  $('inviteList').replaceChildren();
  $('groupMessage').textContent='';
}
export async function refreshMembers() {
  const userId=getState().user?.id;
  if (!userId || getState().demoMode) return;
  const identity=await withAbortTimeout(()=>loadIdentity(userId),{timeoutMs:15000});
  if (getState().user?.id!==userId || getState().pair?.id!==identity.pair.id) return;
  setState(identity);
  membersChanged();
}
async function refreshList(ticket) {
  const rows=await listInvitations();
  if(ticket!==generation) return;
  $('inviteList').replaceChildren();
  for(const row of rows) {
    const item=document.createElement('div'); item.className='group-invite-row';
    const status=row.accepted_at?'prijatá':row.revoked_at?'zrušená':new Date(row.expires_at)<=new Date()?'vypršaná':'aktívna';
    const label=document.createElement('span'); label.textContent=`${row.email} — ${status}`; item.append(label);
    if(status==='aktívna') {
      const button=document.createElement('button'); button.type='button'; button.className='secondary-btn'; button.textContent='Zrušiť pozvánku';
      button.onclick=async()=>{button.disabled=true;try {await revokeInvitation(row.id);await refreshList(ticket);}catch(error){if(ticket===generation)$('groupMessage').textContent=error.message;}finally{button.disabled=false;}};
      item.append(button);
    }
    $('inviteList').append(item);
  }
}
export async function openGroupDialog() {
  if(getState().demoMode) throw new Error('Pozvánky sú dostupné iba v prihlásenom účte.');
  closeGroupDialog(); const ticket=generation;
  $('groupDialog').hidden=false;
  try {
    await refreshMembers();
    if(ticket!==generation)return;
    const owner=getState().membershipRole==='owner';
    $('groupInviteForm').hidden=!owner;
    $('groupMemberNames').textContent=getState().members.map(m=>m.display_name).join(', ');
    if(owner)await refreshList(ticket);
    else $('groupMessage').textContent='Nového človeka môže pozvať vlastník skupiny.';
  } catch(error) {if(ticket===generation)$('groupMessage').textContent=error.message;}
}
export function bindGroupUi(onMembersChanged = () => {}) {
  membersChanged = onMembersChanged;
  $('closeGroupBtn').onclick=closeGroupDialog;
  $('refreshMembersBtn').onclick=()=>openGroupDialog();
  $('groupInviteForm').onsubmit=async event=>{
    event.preventDefault();if(busy)return;
    busy=true;const ticket=generation;const button=$('createInviteBtn');button.disabled=true;
    $('groupMessage').textContent='';
    try {
      const invitation=await createInvitation($('inviteEmail').value,$('inviteShareAll').checked);
      if(ticket!==generation)return;
      $('inviteCode').value=invitation.code;
      $('inviteExpiry').textContent=`Platí do ${new Date(invitation.expires_at).toLocaleString('sk-SK')}. Kód po zatvorení nezobrazíme znovu.`;
      $('inviteResult').hidden=false;
      $('groupInviteForm').reset();
      await refreshList(ticket);
    } catch(error) {if(ticket===generation)$('groupMessage').textContent=error.message;}
    finally{busy=false;button.disabled=false;}
  };
}

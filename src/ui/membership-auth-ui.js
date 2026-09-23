import { signUp, signOut, getSession } from '../services/auth.js';
import { acceptInvitation } from '../services/group-service.js';
const $=id=>document.getElementById(id);
export function resetMembershipAuth() {
  $('joinGroupForm').hidden=true;
  $('joinGroupForm').reset();
  $('loginForm').hidden=false;
  $('registrationPanel').hidden=false;
  $('registerPassword').value='';
}
export function showJoinGroup(user) {
  $('loginForm').hidden=true;
  $('registrationPanel').hidden=true;
  $('joinGroupForm').hidden=false;
  $('joinAccount').textContent=`Prihlásený účet: ${user.email || ''}. Pripoj sa k skupine pomocou pozvánky.`;
}
export function bindMembershipAuth(onJoined, auth = { signUp, signOut, getSession }) {
  let registering=false,joining=false;
  $('registerForm').onsubmit=async event=>{
    event.preventDefault();if(registering)return;registering=true;
    const button=event.currentTarget.querySelector('button');button.disabled=true;
    try {
      if($('registerPassword').value.length<12)throw new Error('Heslo musí mať aspoň 12 znakov.');
      const result=await auth.signUp($('registerEmail').value.trim(),$('registerPassword').value);
      $('registerMessage').textContent=result.session?'Účet je prihlásený. Pokračuj prijatím pozvánky.':'Skontroluj svoju e-mailovú schránku, potvrď účet a potom sa prihlás. Ak účet už existuje, použi prihlásenie.';
    } catch(error){$('registerMessage').textContent=error.message;}
    finally{$('registerPassword').value='';button.disabled=false;registering=false;}
  };
  $('joinGroupForm').onsubmit=async event=>{
    event.preventDefault();if(joining)return;joining=true;
    const button=event.currentTarget.querySelector('button[type="submit"]');button.disabled=true;
    $('joinMessage').textContent='';
    try {
      const session=await auth.getSession();
      if(!session)throw new Error('Najprv sa prihlás.');
      await acceptInvitation($('joinCode').value,$('joinName').value,$('joinShareAll').checked);
      $('joinCode').value='';
      await onJoined(await auth.getSession());
    } catch(error){$('joinMessage').textContent=error.message;}
    finally{button.disabled=false;joining=false;}
  };
  $('joinSignOutBtn').onclick=async()=>{try{await auth.signOut();}catch(error){$('joinMessage').textContent=error.message;}};
}

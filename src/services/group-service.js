import { requireSupabase } from '../lib/supabase.js';
import { withAbortTimeout } from '../lib/async.js';

const messages = {
  GROUP_OWNER_REQUIRED: 'Pozývať ľudí môže iba vlastník skupiny.',
  SHARED_TASKS_CONFIRMATION_REQUIRED: 'Potvrď zdieľanie všetkých spoločných úloh.',
  INVALID_INVITATION: 'Skontroluj e-mail, meno a kód pozvánky.',
  INVITATION_ALREADY_ACTIVE: 'Pre tento e-mail už existuje aktívna pozvánka. Najprv ju zruš.',
  INVITATION_INVALID_OR_EXPIRED: 'Pozvánka neplatí, vypršala alebo patrí inému e-mailu.',
  EMAIL_CONFIRMATION_REQUIRED: 'Najprv potvrď svoj e-mail cez správu zo Supabase.',
  ALREADY_IN_GROUP: 'Tento účet už patrí do skupiny. Existujúce členstvo sa nezmenilo.',
  ALREADY_MEMBER: 'Tento človek už je členom skupiny.',
  GROUP_FULL: 'Skupina môže mať najviac 20 členov.',
  INVITATION_LIMIT: 'Bol dosiahnutý limit pozvánok. Skús to neskôr.',
};
async function rpc(name, args = {}) {
  const { data, error } = await withAbortTimeout(signal => requireSupabase().rpc(name, args).abortSignal(signal), {timeoutMs:15000});
  if (error) throw new Error(messages[error.message] || (['PGRST202','42883'].includes(error.code)
    ? 'Pridávanie členov ešte nie je nasadené na serveri (potrebná migrácia 013).' : 'Operácia so skupinou zlyhala. Skontroluj pripojenie a skús obnoviť zoznam.'));
  return data;
}
export async function createInvitation(email, acknowledged) {
  if (!acknowledged) throw new Error(messages.SHARED_TASKS_CONFIRMATION_REQUIRED);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const code = Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code));
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
  const invitation = await rpc('create_group_invitation',{p_email:email.trim(),p_token_hash:hash,p_ack_all_tasks:true});
  return {...invitation,code};
}
export const listInvitations = () => rpc('list_group_invitations');
export const revokeInvitation = id => rpc('revoke_group_invitation',{p_id:id});
export function acceptInvitation(code, name, acknowledged) {
  return rpc('accept_group_invitation',{p_code:code.trim().toLowerCase(),p_display_name:name.trim(),p_ack_all_tasks:Boolean(acknowledged)});
}

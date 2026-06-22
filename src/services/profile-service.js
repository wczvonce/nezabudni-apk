import { requireSupabase } from '../lib/supabase.js';

export async function loadIdentity(userId) {
  const sb = requireSupabase();
  const { data: membership, error: membershipError } = await sb
    .from('pair_members')
    .select('pair_id')
    .eq('user_id', userId)
    .single();
  if (membershipError) throw membershipError;

  const [{ data: pair, error: pairError }, { data: profile, error: profileError }, { data: memberRows, error: membersError }] = await Promise.all([
    sb.from('pairs').select('id,name').eq('id', membership.pair_id).single(),
    sb.from('profiles').select('id,display_name,email').eq('id', userId).single(),
    sb.from('pair_members').select('user_id').eq('pair_id', membership.pair_id).order('created_at'),
  ]);
  if (pairError) throw pairError;
  if (profileError) throw profileError;
  if (membersError) throw membersError;

  const ids = memberRows.map((row) => row.user_id);
  const { data: members, error: memberProfilesError } = await sb
    .from('profiles')
    .select('id,display_name,email')
    .in('id', ids);
  if (memberProfilesError) throw memberProfilesError;

  const order = new Map(ids.map((id, index) => [id, index]));
  members.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { pair, profile, members };
}

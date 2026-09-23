import { createClient } from '@supabase/supabase-js';
import { CONFIG } from '../src/config.js';
import { mountConsent } from './controller.js';

// A separate, memory-only session: never replace or sign out the mobile/web session.
const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
    storageKey: 'nezabudni-oauth-consent' },
});
mountConsent({ document, auth: supabase.auth, search: location.search,
  grantIntegration: async (clientId, operations) => {
    const { error } = await supabase.rpc('approve_integration_oauth', {
      p_oauth_client_id: clientId, p_operations: operations,
    });
    if (error) throw new Error('integration_grant_failed');
  },
  navigate: url => location.assign(url) });

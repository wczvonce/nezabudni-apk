import { createClient } from '@supabase/supabase-js';
import { CONFIG } from '../src/config.js';
import { mountRecovery } from './recovery-controller.js';

// Recovery must never read or overwrite the normal application's session.
const fragment = location.hash;
history.replaceState(null, '', location.pathname);
const client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
    flowType: 'implicit', storageKey: 'nezabudni-password-recovery' },
});
mountRecovery({ document, auth: client.auth, fragment,
  redirectTo: new URL('/oauth/recovery.html', location.origin).href });

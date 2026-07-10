import { createClient } from '@supabase/supabase-js';
import { CONFIG, hasCloudConfig } from '../config.js';

export const supabase = hasCloudConfig()
  ? createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'nezabudni-v19-auth',
      },
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : null;

// Testovací hook: online cesty (fetchTasks/flushOutbox) sa inak nedajú
// behaviorálne testovať bez živého servera. V produkcii sa nikdy nevolá.
let supabaseOverride = null;
export function __setSupabaseForTests(sb) { supabaseOverride = sb; }

export function requireSupabase() {
  if (supabaseOverride) return supabaseOverride;
  if (!supabase) throw new Error('Supabase ešte nie je nakonfigurovaný.');
  return supabase;
}

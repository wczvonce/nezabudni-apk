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

export function requireSupabase() {
  if (!supabase) throw new Error('Supabase ešte nie je nakonfigurovaný.');
  return supabase;
}

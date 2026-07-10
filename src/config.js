const ENV = import.meta.env || {};

export const CONFIG = Object.freeze({
  appName: 'Nezabudni testovacia',
  // Zdroj pravdy pre verziu webu je package.json — pri release synchronizovať.
  appVersion: '0.2.12',
  bundleId: 'sk.povraznik.nezabudni.test',
  supabaseUrl: ENV.VITE_SUPABASE_URL?.trim() || 'https://ofwouqpqzcpjnigcgygz.supabase.co',
  supabaseKey: ENV.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || 'sb_publishable_q5xQ1rNFeYQsuUtjXllIvg_aJft17Qy',
  oneSignalAppId: ENV.VITE_ONESIGNAL_APP_ID?.trim() || '6b9193d7-db17-4e17-9320-4dcb7c410e76',
  allowDemoMode: String(ENV.VITE_ALLOW_DEMO_MODE ?? 'false') === 'true',
  defaultTimezone: 'Europe/Bratislava',
  maxAttachmentBytes: 10 * 1024 * 1024,
  attachmentBucket: 'task-attachments',
});

export function hasCloudConfig() {
  return Boolean(CONFIG.supabaseUrl && CONFIG.supabaseKey && !CONFIG.supabaseUrl.includes('YOUR_PROJECT'));
}

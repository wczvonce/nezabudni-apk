import { supabase } from '../lib/supabase.js';

const AUTH_TIMEOUT_MS = 15_000;

function withTimeout(promise, message, timeoutMs = AUTH_TIMEOUT_MS) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export async function getSession() {
  if (!supabase) return null;
  const { data, error } = await withTimeout(
    supabase.auth.getSession(),
    'Kontrola prihlásenia trvá príliš dlho. Skontroluj internet a spusti aplikáciu znova.',
  );
  if (error) throw error;
  return data.session;
}

export async function signIn(email, password) {
  if (!supabase) throw new Error('Cloud nie je nakonfigurovaný.');
  const { data, error } = await withTimeout(
    supabase.auth.signInWithPassword({ email, password }),
    'Prihlásenie trvá príliš dlho. Skontroluj internet a skús to znova.',
    20_000,
  );
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) return;
  // scope 'local' = odhlás IBA toto zariadenie (zodpovedá UI „Odhlásiť sa").
  // Globálny scope revokoval refresh token aj partnerovmu/druhému zariadeniu,
  // ktoré sa však nikdy neodregistrovalo z push notifikácií – odhlásený telefón
  // by ďalej dostával notifikácie s názvami úloh.
  const { error } = await withTimeout(
    supabase.auth.signOut({ scope: 'local' }),
    'Odhlásenie trvá príliš dlho. Skontroluj internet a skús to znova.',
  );
  if (error) throw error;
}

export function onAuthChange(callback) {
  if (!supabase) return () => {};

  // DÔLEŽITÉ: Supabase auth callback sa vykonáva počas internej auth operácie.
  // Ďalšie Supabase dotazy priamo/awaitované v callbacku môžu vytvoriť deadlock.
  // Preto callback iba odložíme do ďalšej úlohy event loopu a okamžite sa vrátime.
  let active = true;
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => {
      if (!active) return;
      Promise.resolve(callback(session)).catch((error) => {
        console.error('Auth state handler failed', error);
      });
    }, 0);
  });

  return () => {
    active = false;
    data.subscription.unsubscribe();
  };
}

import { TimeoutError } from './async.js';

// Terminálne autentifikačné signály: neplatný/odvolaný refresh token, zrušená
// relácia, zablokovaný/neexistujúci používateľ. Iba tieto smú viesť k odhláseniu.
const TERMINAL_AUTH_CODES = new Set([
  'refresh_token_not_found',
  'refresh_token_already_used',
  'invalid_grant',
  'bad_jwt',
  'session_not_found',
  'user_not_found',
  'user_banned',
  'session_expired',
]);

const TERMINAL_AUTH_PATTERNS = [
  /invalid refresh token/i,
  /refresh[_ ]?token[_ ]?(not[_ ]?found|already[_ ]?used|revoked|expired)/i,
  /invalid[_ ]?grant/i,
  /session[_ ]?(not[_ ]?found|expired|revoked)/i,
  /user (not found|is banned|banned)/i,
  /refresh token.*(invalid|revoked|expired)/i,
];

// Sieťové / prechodné signály, ktoré NIKDY nesmú odhlásiť používateľa.
const TRANSIENT_PATTERNS = [
  /failed to fetch/i,
  /network ?error/i,
  /networkerror/i,
  /load failed/i,
  /timeout|timed out|trvá príliš dlho/i,
  /fetch failed/i,
  /connection|econnreset|enotfound|etimedout|dns/i,
  /offline/i,
];

/**
 * Rozlíši, či štartová chyba znamená naozaj neplatnú reláciu ('auth'),
 * alebo len prechodný problém ('transient') – sieť, timeout, OneSignal, DB, sync.
 * Bezpečný default je 'transient': odhlasujeme len pri potvrdenom zlyhaní autentifikácie.
 */
export function classifyStartupError(error) {
  if (!error) return 'transient';

  // Timeout je vždy prechodný.
  if (error instanceof TimeoutError || error.name === 'TimeoutError' || error.code === 'TIMEOUT') {
    return 'transient';
  }

  const name = String(error.name || '');
  const message = String(error.message || error || '');
  const haystack = `${name} ${message}`;

  // Prechodné signály majú prednosť – radšej nechaj používateľa prihláseného.
  if (TRANSIENT_PATTERNS.some((re) => re.test(haystack))) return 'transient';
  if (name === 'AbortError' || name === 'TypeError') return 'transient';

  const code = String(error.code || error.error_code || '').toLowerCase();
  if (TERMINAL_AUTH_CODES.has(code)) return 'auth';

  // Auth chyby Supabase (AuthApiError/AuthError) s terminálnym signálom v správe.
  const looksAuthApi = /auth/i.test(name) || error.__isAuthError === true || error.isAuthError === true;
  if (looksAuthApi && TERMINAL_AUTH_PATTERNS.some((re) => re.test(message))) return 'auth';

  // Aj bez auth príznaku, ale s jednoznačnou terminálnou frázou.
  if (TERMINAL_AUTH_PATTERNS.some((re) => re.test(message))) return 'auth';

  return 'transient';
}

export function isTerminalAuthError(error) {
  return classifyStartupError(error) === 'auth';
}

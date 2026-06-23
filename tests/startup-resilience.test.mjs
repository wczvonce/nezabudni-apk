import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withAbortTimeout, TimeoutError } from '../src/lib/async.js';
import { classifyStartupError } from '../src/lib/startup.js';

// ── withAbortTimeout ──────────────────────────────────────────────
// Normálny výsledok prejde.
assert.equal(await withAbortTimeout(() => Promise.resolve(42), { timeoutMs: 1000 }), 42);

// REGRESIA (Issue 9): operácia, ktorá signál IGNORUJE a nikdy sa neukončí,
// sa MUSÍ ukončiť timeoutom – inak by zasekla štart/sync.
{
  let err = null;
  const start = Date.now();
  try {
    await withAbortTimeout(() => new Promise(() => {}), { timeoutMs: 20, message: 'too slow' });
  } catch (e) { err = e; }
  assert.ok(err instanceof TimeoutError, 'zaseknutá operácia sa ukončí TimeoutError-om');
  assert.equal(err.code, 'TIMEOUT');
  assert.ok(Date.now() - start < 1000, 'ukončí sa rýchlo po limite');
}

// Operácia reagujúca na signál dostane abort.
{
  let aborted = false;
  let err = null;
  try {
    await withAbortTimeout((signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }), { timeoutMs: 20 });
  } catch (e) { err = e; }
  assert.ok(aborted, 'signál sa abortne');
  assert.ok(err instanceof TimeoutError, 'výsledok je TimeoutError');
}

// Externý abort sa prepošle s pôvodným dôvodom.
{
  const controller = new AbortController();
  const reason = new Error('external-abort');
  const p = withAbortTimeout(() => new Promise(() => {}), { timeoutMs: 5000, externalSignal: controller.signal });
  controller.abort(reason);
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.equal(err, reason, 'externý abort prepošle pôvodný dôvod');
}

// ── classifyStartupError (Issue 1 scenáre) ────────────────────────
assert.equal(classifyStartupError(new TypeError('Failed to fetch')), 'transient', 'bez internetu = transient');
assert.equal(classifyStartupError(new TimeoutError('Načítanie profilu trvá príliš dlho')), 'transient', 'Supabase timeout = transient');
assert.equal(classifyStartupError(new Error('U.Notifications.addClickListener is not a function')), 'transient', 'OneSignal chyba = transient');
assert.equal(classifyStartupError(new Error('Internal Server Error')), 'transient', 'sync/server chyba = transient');
assert.equal(classifyStartupError(new Error('IndexedDB open failed')), 'transient', 'DB chyba = transient');
assert.equal(classifyStartupError(null), 'transient', 'null = transient (bezpečný default)');
assert.equal(classifyStartupError(undefined), 'transient');

const refreshErr = Object.assign(new Error('Invalid Refresh Token: Refresh Token Not Found'),
  { name: 'AuthApiError', status: 400, code: 'refresh_token_not_found', __isAuthError: true });
assert.equal(classifyStartupError(refreshErr), 'auth', 'neplatný refresh token = auth (odhlásiť)');
assert.equal(classifyStartupError(Object.assign(new Error('Refresh token already used'),
  { code: 'refresh_token_already_used' })), 'auth', 'použitý refresh token = auth');
assert.equal(classifyStartupError(Object.assign(new Error('User is banned'),
  { name: 'AuthApiError', __isAuthError: true })), 'auth', 'zablokovaný používateľ = auth');

// ── Statická štruktúra: main.js (Issue 1) ─────────────────────────
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
assert.match(main, /classifyStartupError/, 'main.js klasifikuje štartové chyby');
assert.doesNotMatch(main, /Nastavenie účtu nie je dokončené/, 'odstránená bounce-to-login po showApp');
assert.match(main, /classifyStartupError\(error\) === 'auth'/, 'odhlásenie iba pri auth chybe');
assert.match(main, /for \(let attempt = 0; attempt < 2/, 'štart sa pri prechodnom zlyhaní ešte raz skúsi (self-healing)');
assert.match(main, /NESMÚ odhlásiť/, 'best-effort fáza: chyby neodhlasujú');
// V boot-fail vetve sa už nesmie volať resetState (relácia ostáva).
assert.doesNotMatch(main, /resetState\(\);\s*\n\s*showAuth\(true, `Nastavenie/, 'boot zlyhanie už nemaže stav');

// ── Statická štruktúra: app-ui.js performSync timeouty (Issue 9) ──
const ui = fs.readFileSync(new URL('../src/ui/app-ui.js', import.meta.url), 'utf8');
assert.match(ui, /withAbortTimeout\(\(signal\) => flushOutbox\(signal\)/, 'flushOutbox má timeout + signál (Issue 9)');
assert.match(ui, /withAbortTimeout\(\(signal\) => fetchTasks\(signal\)/, 'fetchTasks má timeout + signál (Issue 9)');

console.log('startup-resilience.test: OK');

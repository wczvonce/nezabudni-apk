import './styles.css';
import { CONFIG, hasCloudConfig } from './config.js';
import { supabase } from './lib/supabase.js';
import { getSession, signIn, onAuthChange } from './services/auth.js';
import { loadIdentity } from './services/profile-service.js';
import { initTaskService, closeTaskService, cachedTasks, cacheTasks, fetchTasks, flushOutbox } from './services/task-service.js';
import { initializeNotifications, registerCurrentDevice, diagnostics } from './services/notification-service.js';
import { setState, resetState, getState } from './state/store.js';
import {
  bindUi,
  showLoading,
  showAuth,
  showApp,
  render,
  syncNow,
  openTaskFromNotification,
  processPendingNotification,
  resetTransientUi,
  toast,
} from './ui/app-ui.js';
import { platform } from './lib/platform.js';
import { withAbortTimeout } from './lib/async.js';
import { classifyStartupError } from './lib/startup.js';

const BOOT_STEP_TIMEOUT_MS = 20_000;
let unsubscribeAuth = null;
let realtimeChannel = null;
let bootingUserId = null;
let bootPromise = null;
let activeSessionUserId;
let authGeneration = 0;
let authTransitionQueue = Promise.resolve();
let loginBusy = false;

// Adaptér na zdieľaný abortovateľný timeout. Operácia sa už spustila (eager),
// preto ju len pretekáme s časovým limitom; pri timeoute vyhodí TimeoutError,
// ktorý vieme klasifikovať ako prechodný (Issue 1/9).
function withTimeout(promise, message, timeoutMs = BOOT_STEP_TIMEOUT_MS) {
  return withAbortTimeout(() => promise, { timeoutMs, message });
}

function isCurrentTransition(generation, userId) {
  return generation === authGeneration && activeSessionUserId === userId;
}

async function bootstrap() {
  bindUi();
  bindLogin();
  showLoading(true);

  if (platform.isWeb && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('Service worker registration failed', error));
  }

  if (!hasCloudConfig()) {
    showLoading(false);
    document.getElementById('demoBtn').hidden = !CONFIG.allowDemoMode;
    showAuth(true, 'Cloud zatiaľ nie je pripojený. Môžeš spustiť ukážkový režim a skontrolovať nový vzhľad.');
    return;
  }

  unsubscribeAuth = onAuthChange((session) => handleAuthSession(session));
  const session = await getSession();
  await handleAuthSession(session);
}

function handleAuthSession(session) {
  const nextUserId = session?.user?.id ?? null;

  // INITIAL_SESSION, getSession() a TOKEN_REFRESHED môžu oznámiť rovnakého
  // používateľa viackrát. Opakovaný boot by otváral dve DB a dva realtime kanály.
  if (nextUserId === activeSessionUserId) {
    if (nextUserId && bootingUserId === nextUserId && bootPromise) return bootPromise;
    if (nextUserId && getState().user?.id === nextUserId) return Promise.resolve();
    if (!nextUserId && !getState().user) return Promise.resolve();
  }

  activeSessionUserId = nextUserId;
  const generation = ++authGeneration;
  const transition = () => nextUserId
    ? bootUser(session.user, generation)
    : showSignedOut(generation);

  // Zmeny účtu serializujeme. Tak sa odhlásenie nemôže prekrývať so štartom
  // starého účtu a stará odpoveď nemôže neskôr zobraziť cudzie dáta.
  authTransitionQueue = authTransitionQueue.catch(() => {}).then(transition);
  return authTransitionQueue;
}

function setRetryVisible(visible) {
  const btn = document.getElementById('retryBootBtn');
  if (btn) btn.hidden = !visible;
}

function bindLogin() {
  const form = document.getElementById('loginForm');
  const errorBox = document.getElementById('loginError');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (loginBusy) return;
    loginBusy = true;
    setRetryVisible(false);
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    errorBox.textContent = '';
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    try {
      showLoading(true);
      await signIn(email, password);
    } catch (error) {
      showLoading(false);
      showAuth(true);
      errorBox.textContent = translateAuthError(error.message);
    } finally {
      loginBusy = false;
      if (submit) submit.disabled = false;
    }
  });
  document.getElementById('demoBtn').addEventListener('click', bootDemo);
  // Zotavenie po prechodnom zlyhaní štartu: relácia je zachovaná, stačí
  // znovu spustiť boot – bez opätovného zadávania hesla či reštartu appky.
  document.getElementById('retryBootBtn')?.addEventListener('click', async () => {
    setRetryVisible(false);
    showLoading(true);
    try {
      const session = await getSession();
      await handleAuthSession(session);
    } catch (error) {
      showLoading(false);
      setRetryVisible(true);
      showAuth(true, `Štart sa nepodaril (dočasný problém): ${error.message}`);
    }
  });
}

function translateAuthError(message) {
  const text = String(message || '');
  if (text.toLowerCase().includes('invalid login credentials')) return 'Nesprávny e-mail alebo heslo.';
  if (text.toLowerCase().includes('email not confirmed')) return 'E-mail ešte nebol potvrdený.';
  return text || 'Prihlásenie zlyhalo.';
}

let demoBusy = false;
async function bootDemo() {
  if (demoBusy) return;
  demoBusy = true;
  try {
    await bootDemoInner();
  } catch (error) {
    console.error('Demo boot failed', error);
    showLoading(false);
    showAuth(true, `Ukážkový režim sa nepodarilo spustiť: ${error.message}`);
  } finally {
    demoBusy = false;
  }
}

async function bootDemoInner() {
  showLoading(true);
  // Audit A7: repo je verejné — demo režim používa anonymné identity.
  const ivan = { id: '11111111-1111-4111-8111-111111111111', display_name: 'Používateľ A', email: 'user-a@example.com' };
  const dominika = { id: '22222222-2222-4222-8222-222222222222', display_name: 'Používateľ B', email: 'user-b@example.com' };
  const user = { id: ivan.id, email: ivan.email };
  const pair = { id: '33333333-3333-4333-8333-333333333333', name: 'Ukážková dvojica' };
  await initTaskService({ userId: user.id, demoMode: true, pairId: pair.id });
  let tasks = await cachedTasks();
  if (!tasks.length) {
    const now = Date.now();
    tasks = [
      { id: crypto.randomUUID(), pair_id: pair.id, created_by: ivan.id, assigned_to: dominika.id, title: 'Skúšobná úloha pre partnera', notes: 'Takto bude vyzerať úloha, ktorú partnerovi zadáš.', due_at: new Date(now + 60 * 60_000).toISOString(), timezone: 'Europe/Bratislava', priority: 2, pre_reminder_minutes: 5, recurrence_rule: 'none', recurrence_mode: 'after', notify_creator_on_complete: true, reminder_interval_seconds: 60, max_reminders: 10, reminders_sent: 0, status: 'pending', snoozed_until: null, acknowledged_at: null, completed_at: null, deleted_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1, last_changed_by: ivan.id },
      { id: crypto.randomUUID(), pair_id: pair.id, created_by: dominika.id, assigned_to: ivan.id, title: 'Kúpiť veci do domácnosti', notes: 'Partner ti môže takto dopísať úlohu.', due_at: new Date(now + 3 * 60 * 60_000).toISOString(), timezone: 'Europe/Bratislava', priority: 1, pre_reminder_minutes: 0, recurrence_rule: 'none', recurrence_mode: 'after', notify_creator_on_complete: false, reminder_interval_seconds: 60, max_reminders: 10, reminders_sent: 0, status: 'pending', snoozed_until: null, acknowledged_at: null, completed_at: null, deleted_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1, last_changed_by: dominika.id },
    ];
    await cacheTasks(tasks);
  }
  setState({ demoMode: true, user, profile: ivan, pair, members: [ivan, dominika], tasks, notificationStatus: await diagnostics(), booted: true });
  showApp();
}

async function bootUser(user, generation) {
  if (bootingUserId === user.id && bootPromise) return bootPromise;
  bootingUserId = user.id;

  const promise = (async () => {
    showLoading(true);

    // === KRITICKÁ FÁZA: bez nej nevieme zobraziť appku. Prechodné zlyhanie sa
    //     ešte raz tichom skúsi (self-healing); auth zlyhanie sa neskúša znova. ===
    let identity;
    let criticalError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      criticalError = null;
      try {
        await closeCurrentContext();
        if (!isCurrentTransition(generation, user.id)) return;

        identity = await withTimeout(
          loadIdentity(user.id),
          'Načítanie profilu trvá príliš dlho. Skontroluj internet a nastavenie Supabase.',
        );
        if (!isCurrentTransition(generation, user.id)) return;

        await withTimeout(
          initTaskService({ userId: user.id, demoMode: false, pairId: identity.pair.id }),
          'Lokálna databáza sa nepodarila otvoriť.',
        );
        if (!isCurrentTransition(generation, user.id)) return;

        const cached = await cachedTasks();
        if (!isCurrentTransition(generation, user.id)) return;
        resetTransientUi();
        setState({ demoMode: false, user, ...identity, tasks: cached, booted: true, syncError: null });
        showApp();
        break;
      } catch (error) {
        criticalError = error;
        if (classifyStartupError(error) === 'auth') break;
        // Prechodná chyba: krátke čakanie a tichý opätovný pokus.
        if (attempt === 0 && isCurrentTransition(generation, user.id)) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      }
    }
    if (criticalError) {
      if (!isCurrentTransition(generation, user.id)) return;
      console.error('Startup critical phase failed', criticalError);
      // Iba POTVRDENÉ zlyhanie autentifikácie smie odhlásiť. Prechodná chyba
      // (sieť, timeout, DB) ponechá platnú reláciu a ukáže zotaviteľný stav.
      if (classifyStartupError(criticalError) === 'auth') {
        await showSignedOut(generation);
      } else {
        showLoading(false);
        resetTransientUi();
        showAuth(true, `Štart sa nepodaril (dočasný problém): ${criticalError.message} Tvoje prihlásenie je zachované — skús to znova.`);
        setRetryVisible(true);
      }
      return;
    }

    // === NAJLEPŠIA SNAHA: appka je už zobrazená; chyby tu NESMÚ odhlásiť ===
    // Audit A4: overenie verzie backendu — nekompletne zmigrovaný Supabase sa
    // inak prejavuje náhodnými RPC chybami. Nezhoda NEblokuje appku (offline
    // režim musí fungovať), len zobrazí trvalé varovanie a diagnostiku.
    try {
      const REQUIRED_SCHEMA = 11;
      const { data: caps, error: capsError } = await supabase.rpc('get_backend_capabilities');
      const schema = capsError ? 0 : Number(caps?.schema_version || 0);
      if (isCurrentTransition(generation, user.id)) {
        setState({ backendSchema: schema });
        if (schema < REQUIRED_SCHEMA) {
          setState({ syncError: `Databáza je zastaraná (schéma ${schema || 'neznáma'}, appka potrebuje ${REQUIRED_SCHEMA}). Spusti chýbajúce migrácie — niektoré funkcie nebudú fungovať.` });
          render();
        }
      }
    } catch (error) {
      console.warn('Backend capability check failed (non-fatal)', error?.message);
    }
    if (!isCurrentTransition(generation, user.id)) return;

    try {
      const notificationStatus = await withTimeout(
        initializeNotifications(({ taskId, action, kind }) => {
          if (!taskId) return;
          // Push doručený s appkou V POPREDÍ nie je klik používateľa — nesmie
          // sám otvárať alarm/formulár (zahodil by rozpísaný koncept a pri
          // nesplatnej úlohe by ponúkol škodlivé „OK/Odložiť"). Splatné úlohy
          // pripomenie in-app budík (checkDueAlarm); tu stačí toast + sync.
          if (action === 'foreground') {
            const task = getState().tasks.find((t) => t.id === taskId);
            if (task) toast(kind === 'task_completed' ? `✓ Splnené: ${task.title}` : `🔔 ${task.title}`);
            syncNow();
            return;
          }
          openTaskFromNotification(taskId);
        }),
        'Inicializácia upozornení trvá príliš dlho.',
      );
      if (isCurrentTransition(generation, user.id)) { setState({ notificationStatus }); render(); }
    } catch (error) {
      console.warn('Notifications init failed (non-fatal)', error?.message);
    }
    if (!isCurrentTransition(generation, user.id)) return;

    try {
      await withTimeout(registerCurrentDevice(), 'Registrácia zariadenia trvá príliš dlho.');
      if (isCurrentTransition(generation, user.id)) setState({ notificationStatus: await diagnostics() });
    } catch (error) {
      console.warn('Device registration pending', error?.message);
    }
    if (!isCurrentTransition(generation, user.id)) return;

    // Najprv odošli lokálne čakajúce zmeny. Až potom načítaj cloud,
    // inak by sa offline optimistické zmeny mohli dočasne prepísať.
    try {
      // Issue 9 platí aj pri boote: operácie dostanú signál, aby ich zápis po
      // timeoute nezbehol na pozadí a neprepísal novší stav zo syncNow().
      const outbox = await withAbortTimeout((signal) => flushOutbox(signal), { timeoutMs: BOOT_STEP_TIMEOUT_MS, message: 'Synchronizácia offline zmien trvá príliš dlho.' });
      if (!isCurrentTransition(generation, user.id)) return;
      const tasks = await withAbortTimeout((signal) => fetchTasks(signal), { timeoutMs: BOOT_STEP_TIMEOUT_MS, message: 'Načítanie úloh trvá príliš dlho.' });
      if (!isCurrentTransition(generation, user.id)) return;
      setState({
        tasks,
        syncing: false,
        syncError: outbox.unresolved ? `${outbox.unresolved} offline zmien vyžaduje kontrolu` : null,
        failedOutboxCount: outbox.unresolved || 0,
      });
      render();
    } catch (error) {
      // Zlyhanie synchronizácie NESMIE odhlásiť – appka beží ďalej s bannerom.
      if (isCurrentTransition(generation, user.id)) {
        setState({ syncing: false, syncError: 'Synchronizácia zlyhala; skús ručnú synchronizáciu.' });
        render();
      }
      console.warn('Initial sync failed (non-fatal)', error?.message);
    }
    if (!isCurrentTransition(generation, user.id)) return;

    subscribeRealtime(identity.pair.id, generation, user.id);
    processPendingNotification();
  })();

  bootPromise = promise;
  try {
    return await promise;
  } finally {
    if (bootPromise === promise) bootPromise = null;
    if (bootingUserId === user.id) bootingUserId = null;
  }
}

async function closeCurrentContext() {
  if (realtimeChannel && supabase) {
    const channel = realtimeChannel;
    realtimeChannel = null;
    await supabase.removeChannel(channel).catch((error) => console.warn('Realtime channel removal failed', error));
  }
  await closeTaskService();
}

function subscribeRealtime(pairId, generation, userId) {
  if (!supabase || !isCurrentTransition(generation, userId)) return;
  realtimeChannel = supabase.channel(`tasks:${pairId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `pair_id=eq.${pairId}` }, () => {
      if (isCurrentTransition(generation, userId)) syncNow();
    })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR' && isCurrentTransition(generation, userId)) {
        setState({ syncError: 'Realtime pripojenie zlyhalo; použi ručnú synchronizáciu.' });
        render();
      }
    });
}

async function showSignedOut(generation) {
  await closeCurrentContext();
  if (!isCurrentTransition(generation, null)) return;
  resetTransientUi();
  resetState();
  showLoading(false);
  setRetryVisible(false);
  // Pri SIGNED_OUT už nemusí existovať platný JWT, preto tu nevoláme
  // serverové odregistrovanie zariadenia. Manuálne odhlásenie ho vykoná
  // ešte pred zrušením relácie.
  showAuth(true, 'Prihlás sa účtom, ktorý vytvoríme v novom Supabase projekte.');
}

window.addEventListener('beforeunload', () => unsubscribeAuth?.());
bootstrap().catch((error) => {
  console.error(error);
  showLoading(false);
  resetTransientUi();
  showAuth(true, `Spustenie zlyhalo: ${error.message}`);
  toast(error.message, true);
});

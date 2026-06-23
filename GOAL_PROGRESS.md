# GOAL PROGRESS — Android stabilization

Authoritative start commit: `bbc2510e6bd645a11726859a50720112c5e18055` (main)
Working branch: `goal-android-stabilization`
Scope: Android-only stabilization (iOS explicitly deferred).

Legenda stavu: ⬜ todo · 🟡 prebieha · ✅ hotové a otestované · 🚧 blokované

| # | Issue | Stav |
|---|---|---|
| 1 | Startup nesmie odhlásiť pri OneSignal/sync zlyhaní | ✅ |
| 2 | Push worker — ohraničené dávky / deadline | ⬜ |
| 3 | Terminálne úlohy — konzistentné editovanie | ⬜ |
| 4 | Edit aktívnej úlohy → reset alarmu | ⬜ |
| 5 | Opakujúca séria sa nesmie zaseknúť | ⬜ |
| 6 | Offline snooze/complete = absolútne časy | ⬜ |
| 7 | Lokálne alarmy rešpektujú limity pripomienok | ✅ |
| 8 | Foreground — nie dve notifikácie | ⬜ |
| 9 | Sync operácie potrebujú timeouty | ✅ |
| 10 | Inicializácia a listenery iba raz | ✅ |
| 11 | Queued joby re-evaluovať pred spustením | ✅ (worker re-eval + regresné testy) |
| 12 | Správne akcie autor/príjemca (+ dôvod odmietnutia) | ⬜ |
| 13 | Android testy čítajú package z konfigurácie | ✅ |
| 14 | Plánované pripomienky = vysoká push priorita | ✅ (kód+test; deploy neskôr) |
| — | CI (GitHub Actions) | 🟡 pripravené v `ci/ci.yml`; aktivácia blokovaná (token bez `workflow` scope) |
| — | Android instrumentation / runtime matica | 🚧 (emulátor/zariadenie) |
| — | Merge do main + deploy + reporty | ⬜ |

---

## Cyklus 0 — Git safety
- Fetch; `main` = autoritatívny `bbc2510` ✅ (is-ancestor 0).
- `goal-android-stabilization` už existovala na remote (`fb6ddf5`), pochádza z `bbc2510` ✅.
- Diff vs main: pridáva iba `src/lib/async.js` + `docs/GOAL_LOOP_STARTED.md` (žiadne úpravy existujúcich súborov).
- Review prípravných súborov: `async.js` užitočný, ale **nekompletný** (viď Cyklus 1).

## Cyklus 1 — Issue 1 (startup) + Issue 9 (sync timeouty) + oprava primitívu
**Evidence / root cause:**
- `bootUser` mal jediný `try/catch`: akákoľvek chyba PO `showApp()` (OneSignal init, registrácia, sync) → `resetState()` + `showAuth('Nastavenie účtu nie je dokončené')` = používateľ hodený na prihlásenie pri prechodnom zlyhaní. (Reálne pozorované na zariadení.)
- `performSync` (bežná prevádzka) nemal timeout → zaseknutý request drží sync lock natrvalo.
- `withAbortTimeout` len abortol controller; pri operácii ignorujúcej signál sa `await` **nikdy neukončil** → neohraničil zaseknutie.

**Files inspected:** src/main.js, src/services/auth.js, src/services/notification-service.js, src/ui/app-ui.js, src/lib/async.js.

**Files modified / added:**
- `src/lib/async.js` — `withAbortTimeout` preteká timeout/abort s `await` (ohraničí aj operácie nereagujúce na signál).
- `src/lib/startup.js` (nový) — `classifyStartupError()` rozlíši `auth` vs `transient`; bezpečný default `transient`.
- `src/main.js` — `bootUser` rozdelený na **kritickú** fázu (identity/DB/cache → showApp) a **best-effort** fázu (OneSignal/registrácia/sync). Po `showApp` chyby už NEodhlasujú; kritické zlyhanie sa klasifikuje (auth → odhlásiť, transient → ponechať reláciu + zotaviteľná hláška). `withTimeout` napojený na opravený primitív (TimeoutError).
- `src/ui/app-ui.js` — `performSync` má timeouty na `flushOutbox`/`fetchTasks`.

**Tests added:** `tests/startup-resilience.test.mjs` (zapojený do `npm test`):
- withAbortTimeout: normál, **regresia na zaseknutie ignorujúce signál**, abort signálu, externý abort.
- classifyStartupError: 7 Issue-1 scenárov (bez netu, Supabase timeout, OneSignal, sync, DB, neplatný refresh token, použitý token, banned, null).
- Statické kontroly main.js (žiadny bounce-to-login po showApp; odhlásenie iba pri `auth`) a app-ui.js (sync timeouty).

**Commands / results:** `node tests/startup-resilience.test.mjs` → OK; `npm run audit` → OK (všetky testy + worker + validate + build), exit 0.

**Remaining risks:** zotaviteľný stav pri kritickom prechodnom zlyhaní zatiaľ používa `showAuth` s connection-hláškou (bez dedikovaného „Skúsiť znova" tlačidla) — dorieši sa vo finálnom verifikačnom cykle / Issue 10. Runtime overenie na zariadení čaká na emulátor.

**Next action:** Issue 10 (single-flight inicializácia + idempotentná registrácia listenerov v notification-service) — nadväzuje na startup.

## Cyklus 2 — Issue 10 (inicializácia a listenery iba raz)
**Root cause:** `initializeNotifications` používal `if (!initialized)` guard. Dvaja súbežní volajúci (boot + requestPermission/registerDevice) ho obídu pred dokončením `await OneSignal.initialize` → dvojitá inicializácia a **duplicitné** registrácie listenerov (`click`, `pushSubscription change`).

**Files modified / added:**
- `src/lib/async.js` — pridaný `singleFlight(factory)`: súbežní volajúci zdieľajú jeden beh, úspech sa cachuje, zlyhanie je znova spustiteľné, „settled" len po úplnom dobehnutí.
- `src/services/notification-service.js` — inicializácia cez `ensureInitialized = singleFlight(...)`; `handleNotificationClick` / `handleSubscriptionChange` sú stabilné referencie registrované raz. Zachované `addEventListener('click', ...)` + `hasPermission()`.

**Tests added:** `tests/init-single-flight.test.mjs` — súbežné=1 beh; cache po úspechu; retry po zlyhaní; statické kontroly.

**Commands / results:** `npm run audit` → OK (exit 0).

**Next action:** Issue 7 (lokálne alarmy: reminders_sent / max_reminders / interval) v app-ui.js.

## Cyklus 3 — Issue 13 (Android package z konfigurácie)
- `scripts/check-android-package.mjs` + `tests/android-package.test.mjs`: odvodia package z `android/app/build.gradle` (`applicationId`) a overia, že `namespace` aj `capacitor.config.ts` `appId` sa zhodujú; žiadny natvrdo zapísaný/driftujúci package. Zapojené do `npm test` aj nový `check:android` v `audit`.
- `npm run audit` → OK. Commit `7d55227`.

## Cyklus 4 — CI (GitHub Actions)
- Pripravený workflow: web job (`npm ci` + `npm run audit` + `npm audit --audit-level=high`) a Android job (build + `cap sync` + `assembleDebug`, artifact APK). `npm audit --audit-level=high` lokálne → 0 zraniteľností.
- **BLOKÁTOR (GitHub permission):** push súborov do `.github/workflows/` GitHub odmieta, lebo token nemá `workflow` scope (má: gist, read:org, repo). Workflow je preto uložený v **`ci/ci.yml`** (pushnuteľné) + návod na aktiváciu (skopírovať do `.github/workflows/ci.yml` cez web UI, alebo `gh auth refresh -s workflow`). Nepodvádzam – CI „passes" sa nedá potvrdiť, kým nie je aktivované.

**Next action:** Issue 7 (lokálne alarmy: limity pripomienok) v app-ui.js.

## Cyklus 5 — Issue 7 (lokálne alarmy rešpektujú limity)
**Root cause:** `checkDueAlarm` opakovane zobrazoval in-app alarm každý interval bez ohľadu na `max_reminders` — lokálny kanál nerešpektoval rozpočet pripomienok.
**Files:** `src/lib/reminders.js` (nový, čistá logika: `localAlarmAllowed`, `reminderIntervalMs`, terminálny stav, rozpočet); `src/ui/app-ui.js` — `checkDueAlarm` používa `localAlarmAllowed` + lokálne počítadlo `shownAlarmCount` (cap na `max_reminders`), čistené v `resetTransientUi`.
**Tests:** `tests/reminder-limits.test.mjs` — hranice max_reminders (0/1/posledná/nad limit/staré dáta), terminálne stavy, priradenie, interval (min 60s, default), neplatný interval neobíde limit, statická kontrola app-ui.
**Result:** `npm run audit` → OK. 

**Next action:** Issue 14 (vysoká push priorita pre plánované pripomienky) v push-worker — payload, testovateľné staticky.

## Cyklus 6 — Issue 14 (vysoká push priorita pre plánované pripomienky)
**Root cause:** payload dával `priority: 10` len pri `task.priority === 3` (užívateľská urgentnosť). Plánované pripomienky pri normálnej priorite išli ako FCM normal → Doze ich mohol oneskoriť.
**Files:** `supabase/functions/push-worker/index.ts` — pridaný `isScheduledReminder(kind)` (task_pre/due/repeat); `priority`/`ios_interruption_level` = high pre pripomienky alebo `priority===3`, inak normal (task_assigned/completed/test nie sú zbytočne high). Idempotencia (`idempotency_key: job.id`) zachovaná.
**Tests:** rozšírený `tests/worker-static.test.mjs` (isScheduledReminder, reminder kinds, priorita 10). `check:worker` (esbuild compile) → OK.
**Pozn.:** nasadenie opraveného workera prebehne vo fáze deploy (`supabase functions deploy push-worker`).

**Next action:** Issue 11 (re-eval queued jobs) — worker už má časť (versionMatch/effectiveDue/graceMs/live status recheck); doplním + otestujem. Potom backend Issue 12/5/2/3/4/6/8.

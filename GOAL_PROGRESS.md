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
| 7 | Lokálne alarmy rešpektujú limity pripomienok | ⬜ |
| 8 | Foreground — nie dve notifikácie | ⬜ |
| 9 | Sync operácie potrebujú timeouty | ✅ |
| 10 | Inicializácia a listenery iba raz | 🟡 |
| 11 | Queued joby re-evaluovať pred spustením | ⬜ |
| 12 | Správne akcie autor/príjemca (+ dôvod odmietnutia) | ⬜ |
| 13 | Android testy čítajú package z konfigurácie | ⬜ |
| 14 | Plánované pripomienky = vysoká push priorita | ⬜ |
| — | CI (GitHub Actions) | ⬜ |
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

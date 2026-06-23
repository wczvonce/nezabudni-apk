# Android Stabilization Report — Nezabudni testovacia

- **Starting commit:** `bbc2510e6bd645a11726859a50720112c5e18055` (main)
- **Stabilization branch:** `goal-android-stabilization`
- **Final stabilization commit:** `c585234`
- **Supabase project:** `ofwouqpqzcpjnigcgygz` · **OneSignal App ID:** `6b9193d7-db17-4e17-9320-4dcb7c410e76`
- **Android applicationId:** `sk.povraznik.nezabudni.test` · **versionName:** 1.0.5 · **versionCode:** 6
- **Post-stabilization bug-hunt commit:** `f2a1e97` (merged do main) · **APK release:** `v1.0.5`

## Výsledok
Všetkých **14/14** issues opravených a pokrytých automatizovanými testami. `npm run audit` (unit + SQL behavior cez pglite + Edge worker compile + validate + vite build) z čistého `npm ci` → **PASS, 0 zraniteľností**.

## Root cause + riešenie (14 issues)
1. **Štart neodhlasoval** — `bootUser` mal jeden `try/catch`; chyba po `showApp` (OneSignal/sync) → reset + login. *Fix:* rozdelené na kritickú/best-effort fázu; `classifyStartupError` (auth vs transient) – odhlási len pri potvrdenom auth zlyhaní. (`src/main.js`, `src/lib/startup.js`)
2. **Push worker bez deadline** — 25 jobov bez časového limitu. *Fix:* execution deadline 25s + vrátenie nedokončených jobov do fronty. (`supabase/functions/push-worker/index.ts`)
3. **Editovanie terminálnych úloh** — backend to dovolil. *Fix:* migrácia 006 `TASK_NOT_EDITABLE` + UI read-only.
4. **Edit aktívnej úlohy → reset alarmu** — overené (api_update_task reset + version-keyed alarm); regresný test.
5. **Recurring stall** — overené (unique constraint, DST-aware next_occurrence, idempotentná generácia + guard z 001/004); regresný test.
6. **Offline snooze drift** — klient posielal relatívne minúty → server prepočítal z `now()`. *Fix:* migrácia 005 – absolútny čas má prednosť; klient posiela absolútny čas. (pglite test)
7. **Lokálne alarmy ignorovali limity** — *Fix:* `src/lib/reminders.js` `localAlarmAllowed` + per-occurrence počítadlo (cap `max_reminders`).
8. **Foreground dve notifikácie** — *Fix:* `foregroundWillDisplay` + `preventDefault` (potlačí natívnu; in-app ostáva).
9. **Sync bez timeoutov** — *Fix:* `withAbortTimeout` (opravený aj samotný primitív, ktorý neohraničoval operácie ignorujúce signál) okolo `performSync`/`flushOutbox`/`fetchTasks`.
10. **Init/listenery viackrát** — *Fix:* `singleFlight` init; stabilné listenery registrované raz; retry po zlyhaní.
11. **Queued joby bez re-eval** — worker re-evaluuje (loadTask + shouldCancel: príjemca, terminálny stav, acknowledged, verzia, due, grace, live status); regresné testy.
12. **Akcie autor/príjemca** — *Fix:* migrácia 007 – stav `rejected`, `rejection_reason`, **povinný dôvod backend-enforced**, per-user `task_hidden` + RLS, `api_reject_task`/`api_hide_task_for_self`; klient + UI tlačidlá. Skrytie nemaže autorov záznam ani neovplyvní iných.
13. **Android package natvrdo** — *Fix:* `scripts/check-android-package.mjs` + test odvodia package z `build.gradle` a overia zhodu s `capacitor.config.ts`/namespace.
14. **Push priorita** — *Fix:* `isScheduledReminder` → pripomienky (task_pre/due/repeat) dostanú OneSignal priority 10 (FCM high); ostatné správy normálne.

## Migrácie / RLS
- **005** absolútny snooze · **006** terminal edit guard · **007** `rejected` stav + `task_hidden` (RLS: select len `user_id=auth.uid()`, zápis len cez SECURITY DEFINER RPC) + `api_reject_task`/`api_hide_task_for_self` · **008** NULL-bezpečná kontrola páru (`is distinct from`) na 7 funkciách. Všetky aplikované do `ofwouqpqzcpjnigcgygz` (overené naživo).

## Testy (pridané)
`startup-resilience`, `init-single-flight`, `reminder-limits`, `recurrence-safety`, `edit-reschedule`, `offline-snooze-absolute`, `terminal-edit-guard`, `reject-and-hide`, `android-package`, `null-pair-guard` (bug-hunt regresia) — všetky v `npm test`/`npm run audit`.

## Build / deploy
- **Edge Function push-worker:** nasadený (Issue 2+14), bez secretu → HTTP 401 (overené).
- **Migrácie 005/006/007:** aplikované.
- **Android debug APK:** `nezabudni-testovacia-1.0.5-debug.apk` (release v1.0.5) · SHA-256 `48c5a63943a25479f02be3f8031a7cde1d4d54eeccfb0c24071a2f1e06e417ee`. (predošlé 1.0.4 = `d05cf8b2…`)
- **Web (Netlify):** build OK; nasadenie web je samostatný krok (frontend zmeny sú pripravené).

## Externé blokátory (mimo môjho dosahu)
- **CI aktivácia:** GitHub token nemá `workflow` scope → workflow je v `ci/ci.yml`, treba skopírovať do `.github/workflows/ci.yml` (web UI alebo `gh auth refresh -s workflow`). „CI passes" preto nepotvrdené.
- **Android runtime matica (25 scenárov) + instrumentation testy:** nie je pripojený emulátor/zariadenie. Debug APK sa stavia OK; runtime overenie ostáva manuálne.

## Adversariálny bug-hunt (po stabilizácii)
Multi-agent Workflow (21 agentov, ~792k tokenov) hľadal chyby v stabilizačnom diffe naprieč dimenziami (concurrency, security, sql, logic, errors). Nahlásil 16 podozrení, 10 „confirmed". Po vlastnej triáži (kontext repozitára + existujúce testy) som opravil **5 reálnych**, **2 zamietol** ako false-positive:

**Opravené (commit `f2a1e97`, migrácia 008):**
- **SECURITY (critical) – trojhodnotová logika páru.** `v_task.pair_id <> current_pair_id()` zlyhalo, keď `current_pair_id()` = NULL (používateľ mimo páru): `pair_id <> NULL` = NULL → v PL/pgSQL IF brané ako FALSE → autorizácia obídená. *Fix:* migrácia **008** rekreuje všetkých **7** SECURITY DEFINER funkcií (acknowledge/complete/delete/snooze/update/reject/hide) s NULL-bezpečným `is distinct from`. Iba sprísňuje RLS. Nasadené + overené naživo (všetkých 7 `hardened=true`). Regresný test `null-pair-guard.test.mjs` (outsider nemôže complete/snooze/ack/reject/update/delete; legitímny člen áno).
- **CONCURRENCY (critical) – oneskorený sync prepíše novší stav.** `flushOutbox`/`fetchTasks` nectili `AbortSignal`; po timeoute dobehlo Supabase RPC a `putTasks`/`replaceTasks` zapísalo zastaraný stav. *Fix:* obe funkcie prijímajú `signal` a pred zápisom kontrolujú `signal.aborted` (vlastný kód `OPERATION_ABORTED`, ktorý outbox catch znova vyhodí); `withAbortTimeout` pohltí neskoré dobehnutie operácie. (`task-service.js`, `app-ui.js`, `async.js`)
- **ERRORS (high) – osirelá mutácia.** Ak po `enqueue` zlyhal optimistický `putTasks` (napr. kvóta IndexedDB), mutácia ostala vo fronte bez úlohy. *Fix:* rollback (`removeOutbox`) v `queueMutation`.
- **LOGIC (high) – odmietnuté úlohy neviditeľné.** Žiadny tab nezobrazoval `status='rejected'` → tlačidlo „Odstrániť zo svojho zoznamu" bolo nedosiahnuteľné. *Fix:* nový tab/filter **„Odmietnuté"**.
- **LOGIC (medium) – dvojitá foreground notifikácia.** `openTaskSheet` nezatváral budík a `checkDueAlarm` nekontroloval otvorený detail. *Fix:* `openTaskSheet` volá `closeAlarm()`; `checkDueAlarm` preskočí pri otvorenom `taskSheet`.

**Zamietnuté (false-positive po analýze):**
- *Leak listenerov v notification-service* — `singleFlight` registruje listenery práve raz na životnosť appky; nič sa nehromadí. Slepé `removeEventListener` na logout by bez resetu single-flightu rozbilo notifikácie po opätovnom prihlásení.
- *alarmKey bez `version`* — `version` v kľúči je **zámerná** invalidácia po edite (Issue 4), konzistentná s backendovým `reminders_sent=0` na edit aj snooze; kryté testom `edit-reschedule`. Odstránenie by rozsynchronizovalo lokálny budík s push pripomienkami.

## Manuálne overenie na telefóne
1. Nainštaluj `nezabudni-testovacia-1.0.5-debug.apk` (cez existujúcu – rovnaký podpis).
2. Prihlás sa `wczvonce@gmail.com` / `111111` → appka sa otvorí (žiadne zamŕzanie ani „Nastavenie účtu nie je dokončené").
3. Vytvor úlohu, edituj ju (alarm sa preplánuje), splň/odlož (offline aj online), príjemca odmietni s dôvodom, odstráň z vlastného zoznamu.

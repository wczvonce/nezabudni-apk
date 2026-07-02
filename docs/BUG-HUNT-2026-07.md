# Bug-hunt kolo 2 (2026-07-02)

Hĺbková kontrola celej aplikácie (frontend, služby, push worker, SQL migrácie)
po v1.0.5. Všetky opravy sú kryté regresným testom `tests/bug-hunt-2.test.mjs`
a existujúcim `npm run audit` (PASS).

## Opravené – backend (migrácia `009_bug_hunt_2.sql`)

| # | Závažnosť | Problém | Oprava |
|---|---|---|---|
| 1 | HIGH | Odmietnutú (`rejected`) úlohu bolo možné dokončiť oneskorenou offline mutáciou – prepísala odmietnutie, poslala autorovi push a pri `after` režime spawnla nový výskyt | `api_complete_task`: terminálny guard `TASK_NOT_EDITABLE` |
| 2 | MEDIUM | Deadlock: `mark_notification_sent` zamykal job→task, API funkcie task→job; obeťou mohol byť worker po fyzickom odoslaní pushu → dvojité doručenie po stale-recovery | Konzistentné poradie zámkov tasks→notification_jobs |
| 3 | MEDIUM | Jedna „otrávená“ séria (`RECURRENCE_GUARD_EXCEEDED`) zhadzovala celé generovanie opakovaní každú minútu, potichu | Per-series `begin/exception` izolácia + warning |
| 4 | MEDIUM | Dokončenie starej `after` úlohy bolo nemožné (spawn ďalšieho výskytu zhodil celú transakciu) | Izolovaný spawn v `api_complete_task` |
| 5 | MEDIUM | `notification_jobs` bez indexov na `task_id` (cancel v každom RPC pod zámkom = seq scan), stale-recovery a `recipient_id` | 3 nové indexy |
| 6 | LOW | DST drift: denná/týždenná úloha o 02:30 sa po jarnom skoku natrvalo posunula na 03:30 | `next_occurrence` odvodzuje čas z kotvy série (ako monthly) |
| 7 | LOW | `mutation_is_duplicate` check-then-insert race → surová 23505 | `insert … on conflict do nothing` |
| 8 | LOW | Kolízia `occurrence_at` pri edite koreňa série → surová 23505 klientovi | Mapovanie na `TASK_CONFLICT` |
| 9 | LOW | Stale-recovery redoručoval push donekonečna (worker umierajúci po odoslaní) | Recovery rešpektuje strop 5 pokusov |
| 10 | LOW | Deadline-requeue vo workeri spaľoval `attempt_count` bez reálneho pokusu | Nová RPC `requeue_unfinished_jobs` (dekrement) |
| 11 | LOW | Rate-limit testovacej notifikácie mal TOCTOU | Advisory xact lock |
| 12 | – | `003_cron_template`: opakované spustenie duplikovalo vault secret; rotácia mohla nedeterministicky posielať starý secret | delete pred create + `order by created_at desc` |

## Opravené – klient

| # | Závažnosť | Problém | Oprava |
|---|---|---|---|
| 1 | MEDIUM | „Online, ale sieť nefunguje“: optimistická zmena v IndexedDB, ale UI ukazovalo starý stav (riziko duplicitnej mutácie) | `performSync` catch načíta úlohy z lokálnej cache (`app-ui.js`) |
| 2 | MEDIUM | Service worker cachoval chybovú stránku/captive portál ako app shell → otrávený offline štart | `response.ok` guard v navigate vetve (`sw.js`) |
| 3 | MEDIUM | Prílohy sa potichu stratili, keď sieť vypadla počas ukladania (create/update spadol do offline fronty bez súborov) | `attachmentsSkipped` + varovný toast |
| 4 | MEDIUM | Boot `flushOutbox`/`fetchTasks` bez AbortSignal – ochrana Issue 9 počas štartu neplatila | `withAbortTimeout((signal)=>…)` aj v `main.js` |
| 5 | MEDIUM | `failed` outbox mutácia sa po JEDNOM prechodnom serverovom zlyhaní (5xx/429/JWT) už nikdy neopakovala; „Skúsiť znova“ pri `TASK_CONFLICT` deterministicky zlyhávalo (stará `p_expected_version`) | Auto-retry prechodných chýb (max 5), rebase verzie pri vedomom retry |
| 6 | MEDIUM | Push po odhlásení: `signOut()` globálne revokoval token druhému zariadeniu, ktoré sa neodregistrovalo z push; subscription-change event vedel zariadenie re-aktivovať počas logoutu | `signOut({scope:'local'})` + `suspendDeviceRegistration()` |
| 7 | LOW | `isNetworkError` matchoval substring `fetch`/`network` → serverové chyby končili v offline fronte | Presná klasifikácia (TypeError + známe správy) |
| 8 | LOW | Natvrdo `timezone: 'Europe/Bratislava'` pri vytváraní – v zahraničí zlé wall-clock opakovania | `Intl.DateTimeFormat().resolvedOptions().timeZone` |
| 9 | LOW | Netlify SPA fallback vracal `index.html` s `immutable` hlavičkou pre zmazané `/assets/*` → SW navždy cachoval HTML ako JS | `/assets/*` → 404 pred catch-all |
| 10 | LOW | Klik na kartu úlohy, ktorá medzitým zmizla zo stavu, otvoril prázdny formulár „Nová úloha“ | Guard v `handleMainClick` |
| 11 | LOW | Eviction histórie budíkov mohol vyhodiť ŽIVÝ kľúč (Map.set neobnovuje poradie) a vynulovať počítadlo pripomienok | delete+set pred zápisom |
| 12 | LOW | `bootDemo` bez busy guardu a error handlingu (nekonečný spinner) | guard + try/catch |
| 13 | – | Nezaškodné: `bundledWebRuntime` (odstránená voľba v Capacitor 8), HTML atribúty bez `esc()` (hardening) | vyčistené / doplnené `esc()` |

## Vylepšenia

- **„Skúsiť znova“ tlačidlo** pri prechodnom zlyhaní štartu (relácia je zachovaná,
  boot sa reštartne bez zadávania hesla) – `index.html` + `main.js`.
- **Service worker**: cache v2, FIFO limit 80 záznamov (hashované assety zo
  starých deployov sa už nehromadia), runtime cache Google Fonts → offline
  typografia.

## CI

Workflow z `ci/ci.yml` je skopírovaný do `.github/workflows/ci.yml` a aktivovaný
(predchádzajúci blokátor – token bez `workflow` scope – už neplatí).

## Nasadenie

1. `supabase/migrations/009_bug_hunt_2.sql` aplikovať do projektu (SQL editor / CLI).
2. Redeploy Edge Function `push-worker` (používa novú RPC `requeue_unfinished_jobs`).
3. Web: bežný Netlify deploy (nový `netlify.toml` + `sw.js`).
4. Android: rebuild APK – v1.0.6 (versionCode 7).

## Overenie

`npm run audit` → PASS (19 testov vrátane nového `bug-hunt-2`, SQL cez pglite,
worker compile, validate, vite build).

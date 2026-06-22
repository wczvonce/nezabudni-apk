# Aktuálny stav – hĺbkovo auditovaná verzia 0.2.2

## Hotové a automatizovane overené

- nový samostatný projekt bez zásahu do starej aplikácie,
- zachovaný vizuálny štýl v18,
- produkčný Vite build,
- Capacitor Android a iOS projekty,
- OneSignal Capacitor plugin,
- Supabase Auth, úlohy a Realtime vrstva,
- IndexedDB cache striktne oddelená podľa používateľského UUID,
- offline outbox s idempotentnými mutation ID,
- tombstone mazanie,
- databázové migrácie a RLS,
- bezpečný push worker s timeoutom a OneSignal idempotency key,
- serverová fronta notifikácií s deduplikáciou a recovery stale lockov,
- iOS Push Notifications entitlement,
- iOS Background Mode `remote-notification`,
- automatizované SQL, task-service, UI a worker testy,
- npm audit: 0 známych zraniteľností.

Podrobný zoznam nálezov je v `docs/AUDIT-REPORT-SK.md`.

## Už založené a prepojené služby

- nový Supabase projekt `ofwouqpqzcpjnigcgygz` v regióne Frankfurt,
- nový Firebase projekt `nezabudni-testovacia`,
- nová OneSignal aplikácia `6b9193d7-db17-4e17-9320-4dcb7c410e76`,
- FCM v1 credentials úspešne nahraté v OneSignal pre Android,
- verejné Supabase a OneSignal údaje zapracované do frontendu.

## Čaká na nasadenie backendu a účtov

- spustenie SQL migrácií v novom Supabase projekte,
- vytvorenie Auth účtov Ivan a Dominika,
- nastavenie tajných Edge Function secrets,
- nasadenie `push-worker` a Cronu,
- nový samostatný Netlify projekt,
- Apple Developer účet a APNs p8 token pre iPhone.

## Čaká na prvé natívne nasadenie

- fyzický Android test,
- Xcode Signing & Capabilities kontrola,
- OneSignal App Group,
- OneSignal Notification Service Extension,
- TestFlight build a fyzický iPhone test.

## Zámerne odložené do ďalšej etapy

- úplná Google Calendar create/update/delete synchronizácia,
- používateľská správa už nahratých príloh,
- natívne lokálne offline alarmy ako kontrolovaná záloha,
- úplné automatické zlúčenie konfliktných offline zmien; neplatné zmeny sú teraz viditeľné a dajú sa ručne zopakovať alebo zahodiť.


## Dôležité pred ďalším testovaním

- APK, ktorá predtým zamŕzala na „Spúšťam Nezabudni…“, je starší build a neobsahuje opravy 0.2.1/0.2.2.
- Ak už bola na Supabase nasadená pôvodná `001_schema.sql`, spusti inkrementálnu migráciu `004_deep_audit_fixes.sql`.
- Potom zostav novú APK s `versionCode 3` a `versionName 1.0.2`.
- Produkčné potvrdenie vyžaduje fyzický Android test, logcat, Supabase worker/Cron logy a OneSignal delivery logy.

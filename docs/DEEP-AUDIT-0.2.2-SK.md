# Hĺbkový audit Nezabudni v19.0.2.2

Dátum auditu: 22. jún 2026

## Záver

Zdrojový projekt je po opravách vhodný ako testovací základ, ale ešte ho nemožno označiť za produkčne potvrdený. Statická analýza, databázové integračné testy, Edge Function build, webový build a Capacitor synchronizácia prešli. Úplné potvrdenie vyžaduje nový natívny APK build, fyzický Android test a živé backendové logy.

APK, ktorá zamŕzala na obrazovke „Spúšťam Nezabudni…“, je starší build. Neobsahuje ochrany `authGeneration` ani `ACCOUNT_CONTEXT_CHANGED`, a preto sa nesmie používať na overovanie opráv 0.2.1/0.2.2.

## Rozsah auditu

Skontrolované boli:

- bootstrap a Supabase Auth,
- prepínanie/odhlasovanie účtov,
- IndexedDB izolácia,
- online a offline CRUD operácie,
- outbox a idempotencia,
- Realtime synchronizácia,
- prílohy a Supabase Storage,
- SQL schéma, RLS, RPC a opakovanie úloh,
- notifikačná fronta a Edge Function,
- OneSignal retry, TTL a deduplikácia,
- Android manifest/Gradle/Capacitor integrácia,
- iOS plist, entitlementy a projektová konfigurácia,
- service worker a produkčný webový build,
- tajné kľúče, CORS a známe npm zraniteľnosti.

## Opravené kritické a vysoké nálezy

### 1. Supabase Auth deadlock pri štarte

Starý build vykonával ďalšie Supabase operácie počas auth callbacku. Pri obnovenej relácii mohla aplikácia zostať natrvalo na štartovacej obrazovke. Callback je teraz synchronný a asynchrónna obsluha sa vykonáva mimo internej auth operácie. Auth kroky majú timeout.

### 2. Preteky pri prihlásení a odhlásení

`INITIAL_SESSION`, `getSession()` a obnovenie tokenu mohli spustiť súbežný boot. Prechody sú teraz serializované a každá operácia nesie generačný identifikátor.

### 3. Zápis dát starého účtu do cache nového účtu

Po odhlásení počas rozbehnutej synchronizácie mohla neskorá odpoveď starého účtu zapisovať cez globálnu referenciu do už otvorenej databázy druhého účtu. Každá operácia teraz používa nemenný snapshot používateľského kontextu a databázy a po každom `await` overuje, že je stále aktuálny.

### 4. Staré push upozornenie po snooze alebo zmene termínu

Worker a SQL callback kontrolujú verziu úlohy, aktuálny effective due time, stav a acknowledgement. Starý job už nesmie zvýšiť počítadlo nového alarmového cyklu ani vytvoriť predčasný repeat.

### 5. Duplicitné push správy pri strate odpovede

OneSignal požiadavka používa stabilný `idempotency_key` podľa UUID jobu. Zaseknuté `processing` joby sa bezpečne obnovujú a neskorý callback starého workera nemôže prepísať novší výsledok.

### 6. Záplava starých upozornení po návrate online

Due/repeat notifikácie majú krátku dynamickú platnosť. Registrácia nového zariadenia znovu zaradí iba čerstvé informačné správy a test, nie staré alarmy.

### 7. Offline outbox blokovaný jednou chybnou zmenou

Konfliktná alebo neplatná operácia sa označí ako `failed`; ďalšie operácie môžu pokračovať. Používateľ môže zmenu znova skúsiť alebo zahodiť.

### 8. Dvojité kliknutia

Ukladanie, mazanie, splnenie, snooze, nastavenia a prihlásenie majú UI locky. Serverová idempotencia zostáva druhou ochranou.

### 9. Opakovanie po dlhom výpadku

Server nevytvára celý historický backlog. Preskočí na najbližší budúci výskyt s bezpečnostným limitom cyklu.

### 10. Nesprávne správy pri samopriradení

Pri priradení úlohy sebe sa nevytvorí zavádzajúca partnerská notifikácia.

### 11. Neobmedzené testovacie notifikácie

Testovací push je limitovaný na jednu požiadavku za 30 sekúnd na používateľa.

### 12. Základné iOS capability

Hlavný iOS target obsahuje Push Notifications entitlement a Background Mode pre remote notifications. App Group, Notification Service Extension, APNs a podpisovanie ešte vyžadujú Mac, Apple Developer účet a Xcode.

## Testy, ktoré prešli

- verejná konfigurácia,
- regresný test auth deadlocku,
- izolácia účtov a IndexedDB,
- aplikovanie čistej SQL schémy aj inkrementálnej migrácie,
- SQL správanie create/update/snooze/complete/delete,
- mutation idempotencia,
- timezone validácia,
- stale job a worker recovery,
- jedno completion upozornenie,
- ownership zariadenia,
- recurrence cez DST a koniec mesiaca,
- preskočenie historického backlogu,
- task service a offline outbox,
- vizuálny alarm,
- statická bezpečnostná kontrola workera,
- kompilácia Edge Function,
- produkčný Vite build,
- Capacitor sync Android/iOS,
- `npm audit`: 0 známych zraniteľností.

## Zostávajúce známe obmedzenia a riziká

### Vyžadujú ďalší vývoj

- Prílohy sa vedia nahrať, ale aplikácia zatiaľ nemá kompletnú obrazovku na zobrazenie, stiahnutie a odstránenie existujúcich príloh.
- Vymazanie úlohy odstráni databázové metadata príloh, ale Storage objekty môžu zostať ako siroty. Treba serverový cleanup.
- Google Kalendár je zámerne vypnutý; nie je vytvorená plná create/update/delete synchronizácia.
- Nie je implementované vrátenie už splnenej úlohy späť do pending stavu.
- Chýba periodické čistenie starých tombstones, `client_mutations`, `task_events`, notifikačných jobov a neaktívnych subscriptions.
- Cestovanie do inej časovej zóny môže meniť význam lokálne zadaného času; UI zatiaľ explicitne neponúka výber časovej zóny.
- Cron template nie je úplne bezpečný na opakované slepé spustenie; pred opakovaním treba overiť existujúci job a Vault secret.

### Platformové obmedzenia

- iOS push nemožno otestovať bez APNs, Apple Developer účtu, podpisu a fyzického iPhonu.
- Android push nemožno potvrdiť bez nového APK buildu a fyzického telefónu.
- Aj natívna notifikácia rešpektuje systémové povolenia, Focus/tichý režim a internetovú dostupnosť pre vzdialený push.

### Neodstrániteľný distribuovaný okrajový prípad

Ak push fyzicky odíde do OneSignal v rovnakých milisekundách, keď používateľ úlohu odloží alebo zruší, starú správu už nemožno vziať späť. Serverové kontroly však zabezpečia, že tento starý job nezmení nový alarmový cyklus a nevytvorí ďalšie nesprávne opakovanie.

## Čo treba na úplnú runtime diagnostiku

Bez tajných údajov stačí dodať:

1. APK zostavenú z tejto verzie 0.2.2,
2. model telefónu a verziu Androidu,
3. presné kroky reprodukcie,
4. `adb logcat` od cold startu po chybu,
5. Supabase Edge Function a Cron/Database logy z rovnakého času,
6. OneSignal delivery/subscription stav pre testovaciu správu,
7. anonymizovaný riadok príslušného `notification_jobs`, ak ide o push problém.

Nikdy neposielať heslá, Supabase service-role key, OneSignal REST API key, worker secret ani Firebase private JSON.

## Povinné nasadenie pred ďalším testom

Ak už existuje nasadený backend zo staršej verzie:

1. spusti `supabase/migrations/004_deep_audit_fixes.sql`,
2. znova nasaď `supabase/functions/push-worker`,
3. zostav APK s `versionCode 3` a `versionName 1.0.2`,
4. odinštaluj starú testovaciu APK alebo vymaž jej dáta,
5. nainštaluj nový build a až potom zbieraj logcat.

## Výsledok pokusu o Android natívny build v auditnom prostredí

Príkaz `./gradlew assembleDebug` sa zastavil ešte pred kompiláciou, pretože prostredie nevedelo DNS pripojiť k `services.gradle.org` a stiahnuť Gradle 8.14.3 (`UnknownHostException`). Nejde o zistenú chybu zdrojového kódu; natívna Android kompilácia preto zostáva neoverená a musí prebehnúť na počítači s Android Studio/JDK a funkčným internetom.

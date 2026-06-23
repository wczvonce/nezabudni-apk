# Android Stabilization Report — Nezabudni testovacia

- **Starting commit:** `bbc2510e6bd645a11726859a50720112c5e18055`
- **Stabilization branch:** `goal-android-stabilization`
- **Android applicationId:** `sk.povraznik.nezabudni.test`
- **versionName:** 1.0.5 · **versionCode:** 6
- **Post-stabilization bug-hunt:** `f2a1e97`

## Výsledok stabilizácie

Pôvodných 14 problémov bolo opravených a pokrytých automatizovanými testami. Audit zahŕňa unit testy, SQL behavior testy cez PGlite, kontrolu Edge Function, Android package validáciu a produkčný Vite build.

## Hlavné opravy

1. Štart odhlasuje iba pri potvrdenej auth chybe; sieťové a prechodné chyby zachovajú reláciu.
2. Push worker má deadline a nedokončené joby bezpečne vracia do fronty.
3. Terminálne úlohy sú v UI iba na čítanie a backend ich nedovolí editovať.
4. Edit aktívnej úlohy resetuje a preplánuje alarmy.
5. Recurring úlohy majú idempotentnú generáciu a ochranu proti zaseknutiu.
6. Offline snooze používa absolútny čas.
7. Lokálne alarmy rešpektujú maximálny počet pripomenutí.
8. Foreground push nevytvára duplicitnú natívnu a in-app notifikáciu.
9. Synchronizácia používa abortovateľné timeouty.
10. OneSignal inicializácia a listenery používajú single-flight.
11. Worker pred odoslaním znovu kontroluje aktuálny stav úlohy.
12. Príjemca môže úlohu odmietnuť s povinným dôvodom a skryť terminálnu úlohu zo svojho zoznamu.
13. Android package sa kontroluje proti Gradle a Capacitor konfigurácii.
14. Časovo citlivé pripomienky používajú vysokú push prioritu.

## Dodatočné bezpečnostné opravy

- Migrácia **008** používa NULL-bezpečnú kontrolu členstva páru cez `is distinct from` vo všetkých zasiahnutých SECURITY DEFINER funkciách.
- Štart aplikácie používa `startup-task-service.js`, ktorý serializuje inicializáciu IndexedDB a zabraňuje tomu, aby oneskorený pokus prepísal kontext novšieho účtu.
- Štartovací `flushOutbox` a `fetchTasks` dostávajú skutočný `AbortSignal` aj napriek historickému eager timeout wrapperu v `main.js`.
- Migrácia **009** blokuje neplatný prechod terminálnej úlohy, napríklad `rejected → completed`, cez chybu `TASK_NOT_COMPLETABLE`.
- Demo režim už neobsahuje súkromné e-mailové adresy.
- GitHub Actions je aktívny v `.github/workflows/ci.yml`.

## Migrácie

- **005** absolútny snooze
- **006** terminal edit guard
- **007** rejected stav a per-user skrytie
- **008** NULL-safe pair guard
- **009** terminal complete guard

Migráciu **009** treba aplikovať do produkčného Supabase projektu pred nasadením klienta s touto opravou.

## Bezpečnosť prihlasovacích údajov

Repozitár ani dokumentácia nesmú obsahovať reálne heslá, prihlasovacie kombinácie alebo obnovovacie tokeny. Heslo, ktoré bolo v staršej verzii dokumentu, treba považovať za kompromitované: zmeniť ho v Supabase, ukončiť existujúce sessions a následne vyčistiť aj Git históriu.

## Automatické testy

Okrem pôvodných testov sú pridané:

- `startup-task-service.test.mjs`
- `terminal-complete-guard.test.mjs`

GitHub Actions vykonáva `npm ci`, `npm run audit`, dependency audit a Android debug build. Android runtime scenáre na skutočnom zariadení zostávajú samostatným manuálnym overením.

## Manuálne overenie na telefóne

1. Nainštaluj debug APK s rovnakým applicationId.
2. Prihlás sa vlastnými aktuálnymi údajmi; prihlasovacie údaje sa nesmú zapisovať do repozitára.
3. Over vytvorenie, editáciu, splnenie, odloženie, offline synchronizáciu, odmietnutie s dôvodom a skrytie terminálnej úlohy.
4. Over rýchle odhlásenie a prihlásenie iného účtu počas pomalého štartu.
5. Over, že odmietnutú úlohu nemožno cez backend zmeniť na splnenú.

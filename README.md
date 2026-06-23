# Nezabudni testovacia – Android 1.0.6

Samostatný testovací projekt aplikácie **Nezabudni testovacia**. Pôvodná produkčná aplikácia sa týmto repozitárom nemení.

## Technológie

- čisté HTML/CSS/JavaScript moduly,
- Vite,
- Capacitor 8 pre Android a iPhone,
- Supabase Auth + PostgreSQL + Storage + Realtime,
- OneSignal natívny SDK,
- Supabase Edge Function ako chránený push worker.

## Bundle ID

`sk.povraznik.nezabudni.test`

## Hlavné funkcie

- spoločné úlohy pre dvojicu používateľov,
- oddelenie autora a príjemcu úlohy,
- priority, predpripomienka, snooze a opakovanie,
- odmietnutie úlohy s povinným dôvodom,
- offline IndexedDB cache oddelená podľa účtu,
- idempotentný offline outbox,
- serverová notifikačná fronta,
- OneSignal push s retry a deduplikáciou,
- diagnostika notifikácií,
- ukážkový režim bez reálnych prihlasovacích údajov.

## Bezpečnosť a stabilita 1.0.6

- štart aplikácie rozlišuje auth a dočasné chyby,
- IndexedDB open má timeout a spracovanie `onblocked`,
- oneskorený štart starého účtu nemôže prepísať nový účet,
- registrácia a odregistrácia push zariadenia sú serializované,
- odmietnutá alebo zrušená úloha sa nedá spätne označiť ako splnená,
- CI zostavuje Android cez Java 21 a Android SDK 36.

## Verejné konfiguračné hodnoty

Supabase publishable key, Project URL a OneSignal App ID sú klientské verejné hodnoty. Tajné serverové kľúče v repozitári nesmú byť.

Nikdy necommituj:

- heslá používateľov,
- Supabase service-role key,
- OneSignal REST API key,
- Firebase Service Account JSON,
- `PUSH_WORKER_SECRET`,
- podpisovací keystore.

## Kompletná kontrola

```bash
npm ci
npm run audit
npx cap sync android
cd android
./gradlew assembleDebug
```

GitHub Actions vykonáva rovnaký webový audit a Android debug build automaticky.

## Povinné Supabase migrácie

Pri existujúcom testovacom backende spusti v tomto poradí:

```text
004_deep_audit_fixes.sql
005_offline_absolute_times.sql
006_terminal_edit_guard.sql
007_reject_and_hide.sql
008_fix_null_pair_guard.sql
009_terminal_complete_guard.sql
```

Pri úplne novom projekte najprv spusti `001_schema.sql`, vytvor účty a dvojicu cez `002_setup_pair_template.sql`, potom aplikuj všetky dostupné inkrementálne migrácie 004–009. Migrácie sú navrhnuté ako aditívne opravy; pred produkčným použitím ich vždy najprv otestuj na testovacom projekte.

## Lokálne spustenie

```bash
cp .env.example .env
npm ci
npm run dev
```

## Android build

Vyžaduje Java 21 a Android SDK 36:

```bash
npm ci
npm run audit
npx cap sync android
cd android
./gradlew assembleDebug
```

Výsledný súbor je v `android/app/build/outputs/apk/debug/app-debug.apk`.

## Stav obmedzení

Naďalej zostáva manuálne otestovať najmä:

- notifikácie pri úplne zatvorenej aplikácii a zamknutej obrazovke,
- Android Doze a výrobcom obmedzené batériové režimy,
- rýchle prepínanie účtov na fyzickom telefóne,
- dlhší offline režim a následnú synchronizáciu,
- iOS signing, APNs a Notification Service Extension.

Podrobný postup nasadenia je v `docs/DEPLOYMENT-SK.md` a výsledok stabilizácie v `ANDROID_STABILIZATION_REPORT.md`.

# Nezabudni testovacia

> Zdroj pravdy pre verzie: web `package.json` (`version`), Android `android/app/build.gradle` (`versionName`/`versionCode`). Číslovania sú nezávislé.

Nový samostatný projekt aplikácie **Nezabudni testovacia** pre Ivana Povrazníka a Dominiku. Pôvodná aplikácia na `magenta-palmier-e4333d.netlify.app` sa týmto projektom nemení.

## Technológie

- čisté HTML/CSS/JavaScript moduly bez UI frameworku,
- Vite na build,
- Capacitor 8 pre Android a iPhone,
- Supabase Auth + PostgreSQL + Storage + Realtime,
- OneSignal natívny SDK ako jediný systém push notifikácií,
- Supabase Edge Function ako chránený push worker.

## Bundle ID

`sk.povraznik.nezabudni.test`

## Hlavné funkcie

- prihlásenie Ivana a Dominiky,
- jedna spoločná dvojica,
- spoločné úlohy s `created_by` a `assigned_to`,
- úloha pre seba alebo partnera,
- checkbox upozornenia autora po splnení,
- priority, predpripomienka, snooze, opakovanie a počet alarmov,
- tombstones pri mazaní,
- offline IndexedDB cache oddelená podľa účtu,
- idempotentný outbox,
- bezpečné databázové RPC,
- serverová notifikačná fronta s deduplikáciou,
- OneSignal retry ochrana cez `idempotency_key`,
- Android a iOS Capacitor projekty,
- diagnostika notifikácií,
- ukážkový režim bez Supabase údajov.

## Pripojené testovacie služby

Verejná konfigurácia nového Supabase, Firebase a OneSignal projektu je už zapracovaná. Presný prehľad je v `docs/PROJECT-CONNECTIONS.md`. Tajné serverové kľúče v tomto projekte nie sú.

## Audit

Kompletná kontrola:

```bash
npm ci
npm run audit
npx cap sync android
npx cap sync ios
npm audit
```

Podrobný výsledok: `docs/DEEP-AUDIT-0.2.2-SK.md`.

## Vedome odložené alebo obmedzené

- skutočná Google Calendar create/update/delete synchronizácia,
- kompletná používateľská správa a čistenie cloudových príloh,
- natívne lokálne offline alarmy,
- automatické čistenie starých tombstones, udalostí a notifikačných jobov,
- iOS App Group, Notification Service Extension a APNs nastavenie na Macu.

## Lokálne spustenie

```bash
cp .env.example .env
npm ci
npm run dev
```

Verejná cloud konfigurácia (Supabase URL, publishable key, OneSignal App ID) je zámerne zapracovaná priamo v `src/config.js` — appka sa teda aj bez `.env` pripája na testovací cloud. Ukážkový režim sa zobrazí len s `VITE_ALLOW_DEMO_MODE=true` (tlačidlo na prihlasovacej obrazovke). `.env` slúži na prepísanie hodnôt.

## Produkčný build

```bash
npm run audit
npx cap sync
```

Podrobný postup je v `docs/DEPLOYMENT-SK.md`.


## Oprava v0.2.1
Opravené zamrznutie na „Spúšťam Nezabudni…“ spôsobené Supabase auth deadlockom. Podrobnosti: `docs/BUGFIX-STARTUP-FREEZE-0.2.1.md`.


## Hĺbkový audit v0.2.2

Verzia 0.2.2 pridáva ochranu pred prepnutím účtu počas synchronizácie, bezpečnejší offline outbox, opravy stale push jobov po snooze/úprave, ochranu pred dvojitým kliknutím, rate-limit testovacích pushov a opravené opakovanie po dlhšom výpadku.

Ak už bola v Supabase nasadená migrácia `001_schema.sql`, pred testovaním tejto APK spusti aj `supabase/migrations/004_deep_audit_fixes.sql`. Pri úplne novej databáze je rovnaká logika už zahrnutá v aktualizovanej `001_schema.sql`.

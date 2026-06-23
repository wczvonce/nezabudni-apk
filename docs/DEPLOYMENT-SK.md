# Nasadenie Nezabudni testovacia 1.0.6

## 1. Predpoklady

- Node.js 22,
- Java 21,
- Android SDK 36 a Build Tools 36.0.0,
- Supabase CLI pre Edge Function,
- Android Studio pre lokálny build a test zariadenia.

Android application ID je `sk.povraznik.nezabudni.test`.

## 2. Supabase databáza

### Úplne nový projekt

1. Spusti `supabase/migrations/001_schema.sql`.
2. V Supabase Authentication vytvor oba používateľské účty so silnými heslami.
3. Uprav a spusti `supabase/migrations/002_setup_pair_template.sql`.
4. Následne spusti inkrementálne migrácie v poradí:

```text
004_deep_audit_fixes.sql
005_offline_absolute_times.sql
006_terminal_edit_guard.sql
007_reject_and_hide.sql
008_fix_null_pair_guard.sql
009_terminal_complete_guard.sql
```

### Existujúci testovací projekt

Nespúšťaj `001_schema.sql` znova naslepo. Spusti iba ešte neaplikované inkrementálne migrácie 004–009, vždy v číselnom poradí.

Migrácia 009 je povinná pre verziu 1.0.6. Blokuje neplatný prechod terminálnej úlohy, napríklad `rejected → completed`.

Pred migráciou databázy vytvor zálohu a najprv ju over na testovacom projekte.

## 3. Používateľské účty

Aplikácia nemá verejnú registráciu. Účty vytvor ručne v **Authentication → Users**.

- používaj silné, unikátne heslá,
- heslá nepíš do dokumentácie, zdrojového kódu ani GitHub issues,
- po podozrení na zverejnenie heslo okamžite zmeň a ukonči aktívne sessions.

## 4. Verejná klientská konfigurácia

Frontend používa tieto typy verejných hodnôt:

```env
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=PUBLIC_KEY
VITE_ONESIGNAL_APP_ID=ONESIGNAL_APP_ID
VITE_ALLOW_DEMO_MODE=false
```

Supabase publishable key a OneSignal App ID nie sú serverové tajomstvá. Do frontendu však nikdy nevkladaj:

- Supabase service-role key,
- databázové heslo,
- OneSignal REST API key,
- Firebase Service Account JSON,
- `PUSH_WORKER_SECRET`.

## 5. OneSignal a Firebase

### Android

- Application ID musí byť `sk.povraznik.nezabudni.test`.
- FCM v1 credentials musia byť nahraté priamo v OneSignal.
- OneSignal App ID musí zodpovedať klientskému nastaveniu.
- `google-services.json` nie je pre túto OneSignal integráciu sám osebe rozhodujúci; dôležité sú FCM v1 credentials a správny application ID.

### iOS

Pred iOS nasadením treba dokončiť:

- Apple Developer signing,
- APNs p8 token v OneSignal,
- Push Notifications capability,
- Background Modes → Remote notifications,
- App Group,
- OneSignal Notification Service Extension.

## 6. Edge Function secrets

```bash
supabase link --project-ref PROJECT_REF
supabase secrets set ONESIGNAL_REST_API_KEY="TAJNY_KLUC"
supabase secrets set ONESIGNAL_APP_ID="ONESIGNAL_APP_ID"
supabase secrets set PUSH_WORKER_SECRET="DLHY_NAHODNY_TEXT"
```

Secrets ukladaj iba v Supabase. Necommituj ich do `.env`, SQL šablón ani GitHubu.

## 7. Nasadenie push workeru

```bash
supabase functions deploy push-worker --no-verify-jwt
```

Worker overuje hlavičku `x-worker-secret`. Bez správnej hodnoty musí vrátiť HTTP 401.

## 8. Cron

V `supabase/migrations/003_cron_template.sql` nahraď šablónové hodnoty:

- `YOUR_PROJECT_REF`,
- `REPLACE_WITH_LONG_RANDOM_SECRET`.

Upravený súbor s reálnym secretom necommituj. Worker má byť volaný každú minútu.

## 9. Web build

```bash
npm ci
npm run audit
npm run build
```

Výstup je v `dist/`. Webová verzia slúži aj ako náhľad; natívne OneSignal správanie treba overiť v Android/iOS aplikácii.

## 10. Android debug build

```bash
npm ci
npm run audit
npx cap sync android
cd android
chmod +x ./gradlew
./gradlew assembleDebug --no-daemon --stacktrace
```

Vyžadované verzie:

- Java 21,
- compile/target SDK 36,
- Build Tools 36.0.0.

APK vznikne v:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Verzia 1.0.6 používa `versionCode 7`.

## 11. GitHub Actions

Workflow `.github/workflows/ci.yml` spúšťa:

- čistý `npm ci`,
- kompletný `npm run audit`,
- dependency security audit,
- `npx cap sync android`,
- kontrolu Java/SDK/package konfigurácie,
- Gradle `assembleDebug`,
- upload APK artefaktu.

PR nezlučuj, kým oba joby nie sú zelené.

## 12. Povinná runtime matica na fyzických telefónoch

### Úlohy a synchronizácia

- používateľ A → A,
- A → B,
- B → A,
- B → B,
- vytvorenie, editácia, splnenie, snooze a vymazanie,
- odmietnutie s povinným dôvodom,
- odmietnutú úlohu nemožno označiť ako splnenú,
- dlhší offline režim a následná synchronizácia,
- konflikt dvoch zmien tej istej úlohy.

### Štart a účty

- štart bez internetu,
- pomalé alebo blokované IndexedDB,
- rýchle odhlásenie počas štartu,
- prihlásenie druhého účtu po blokovanom štarte prvého,
- cache používateľa A sa nesmie zobraziť používateľovi B.

### Push notifikácie

- aplikácia v popredí,
- aplikácia na pozadí,
- aplikácia úplne zatvorená,
- zamknutá obrazovka,
- Android Doze/battery optimization,
- odhlásenie deaktivuje subscription,
- druhý účet vie subscription znovu bezpečne zaregistrovať,
- splnenie so zapnutým/vypnutým upozornením autora,
- snooze a opakované pripomenutia,
- žiadne duplicitné foreground notifikácie.

## 13. Bezpečnostný checklist

- reálne heslá nie sú v aktuálnom strome ani dokumentácii,
- predtým zverejnené heslá sú zmenené,
- staré sessions sú ukončené,
- Git história je samostatne vyčistená alebo repozitár je považovaný za kompromitovaný archív,
- service-role a OneSignal REST key sú iba v Supabase secrets,
- release podpisovací kľúč nie je v repozitári,
- migrácia 009 je aplikovaná pred nasadením klienta 1.0.6.

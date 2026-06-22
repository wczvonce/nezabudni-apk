# Nasadenie Nezabudni v19

## 1. Nový Supabase projekt

Nový Supabase projekt je už vytvorený: `ofwouqpqzcpjnigcgygz` (`https://ofwouqpqzcpjnigcgygz.supabase.co`). Starý projekt z predchádzajúcej verzie zostáva nedotknutý.

V SQL Editore spusti v tomto poradí:

1. `supabase/migrations/001_schema.sql`
2. vytvor používateľov podľa časti 2,
3. `supabase/migrations/002_setup_pair_template.sql`

Ak už bola staršia verzia `001_schema.sql` nasadená, nespúšťaj ju znova naslepo. Namiesto toho spusti aj inkrementálnu migráciu `supabase/migrations/004_deep_audit_fixes.sql`, ktorá aktualizuje dotknuté RPC funkcie bez mazania dát.

## 2. Vytvorenie účtov

V Supabase otvor **Authentication → Users → Add user** a vytvor:

- `wczvonce@gmail.com` – Ivan Povrazník,
- `domi.mikloskova@gmail.com` – Dominika.

Nastav dočasné silné heslá. Verejnú registráciu aplikácia neponúka.

Potom spusti `002_setup_pair_template.sql`. Skript vytvorí profily a dvojicu „Ivan a Dominika“.

## 3. Verejné konfiguračné hodnoty

V Supabase Project Settings → API skopíruj:

- Project URL,
- publishable/anon key.

Verejné hodnoty sú už zapracované priamo v `src/config.js`. Voliteľne ich môžeš prepísať cez `.env`:

```env
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...
VITE_ONESIGNAL_APP_ID=...
VITE_ALLOW_DEMO_MODE=false
```

Do frontendu nikdy nevkladaj service-role/secret key ani OneSignal REST API key.

## 4. Nová OneSignal aplikácia

OneSignal aplikácia **Nezabudni testovacia** je už vytvorená. App ID: `6b9193d7-db17-4e17-9320-4dcb7c410e76`. Jedna OneSignal aplikácia bude obsahovať Android aj iOS platformu.

### Android

- Application ID: `sk.povraznik.nezabudni.test`
- Firebase projekt `nezabudni-testovacia` je už vytvorený,
- FCM v1 Service Account credentials sú už úspešne nahraté v OneSignal,
- OneSignal Android platforma je aktívna,
- OneSignal App ID je už zapracované vo frontende.

Lokálny súbor `android/app/google-services.json` OneSignal Capacitor integrácia v tomto projekte sama osebe nevyžaduje. Rozhodujúce sú správne FCM credentials v OneSignal a správne Application ID.

### iPhone

- Bundle ID: `sk.povraznik.nezabudni.test`
- potrebuješ Apple Developer Program,
- v OneSignal nastav APNs p8 token,
- v Xcode skontroluj Push Notifications capability,
- v Xcode skontroluj Background Modes → Remote notifications,
- vytvor App Group `group.sk.povraznik.nezabudni.test.onesignal`,
- pridaj OneSignal Notification Service Extension podľa aktuálneho OneSignal Capacitor návodu,
- rovnakú App Group pridaj hlavnému targetu aj extension targetu.

Push entitlement a background mode sú už v zdrojovom projekte pripravené, ale signing, App Group a NSE sa musia potvrdiť na Macu v Xcode.

## 5. Tajné serverové hodnoty

Po prihlásení do Supabase CLI najprv prepoj lokálny projekt:

```bash
supabase link --project-ref ofwouqpqzcpjnigcgygz
```

Potom v Supabase Edge Function secrets nastav:

```bash
supabase secrets set ONESIGNAL_REST_API_KEY="NOVY_TAJNY_KLUC"
supabase secrets set ONESIGNAL_APP_ID="ONESIGNAL_APP_ID"
supabase secrets set PUSH_WORKER_SECRET="DLHY_NAHODNY_TEXT"
```

OneSignal REST API kľúč nesmie byť v `.env`, JavaScripte, ZIP-e ani GitHube.

## 6. Nasadenie Edge Function

```bash
supabase functions deploy push-worker --no-verify-jwt
```

Funkcia nepoužíva používateľský JWT, pretože ju volá Cron. Namiesto neho povinne overuje samostatnú hlavičku `x-worker-secret`. Bez správneho tajného textu vráti HTTP 401.

## 7. Cron

Otvor `supabase/migrations/003_cron_template.sql` a nahraď:

- `YOUR_PROJECT_REF` hodnotou `ofwouqpqzcpjnigcgygz`,
- `REPLACE_WITH_LONG_RANDOM_SECRET` rovnakou hodnotou ako `PUSH_WORKER_SECRET`.

Skript ukladá URL aj secret do Supabase Vault. Upravenú verziu s reálnym secretom necommituj do GitHubu ani ju neposielaj v ZIP-e.

Po spustení sa worker volá každú minútu.

## 8. Netlify – nový samostatný projekt

Na Netlify vytvor nový projekt. Starú stránku `magenta-palmier-e4333d.netlify.app` nemeníš.

Build command:

```text
npm run build
```

Publish directory:

```text
dist
```

V Netlify Environment Variables nastav verejné `VITE_...` hodnoty.

Webová verzia je náhľad a cloudový klient. Natívny OneSignal push sa testuje v Android/iPhone buildoch.

## 9. Android

Nainštaluj Android Studio a Android SDK. Potom:

```bash
npm ci
npm run audit
npx cap sync android
npx cap open android
```

V Android Studio vyber fyzický telefón a spusti aplikáciu. V nastaveniach aplikácie použi „Zapnúť upozornenia“ a následne „Poslať testovaciu notifikáciu“.

## 10. iPhone bez vlastného Macu

Zdrojový iOS projekt je v `ios/`. Na podpis a TestFlight potrebuješ:

- Apple Developer Program,
- Mac s Xcode alebo cloudový macOS build,
- APNs/OneSignal nastavenia.

Odporúčaný postup:

1. overiť databázu a Android,
2. založiť Apple Developer účet,
3. na Macu dokončiť App Group a Notification Service Extension,
4. skontrolovať signing pre `sk.povraznik.nezabudni.test`,
5. nahrať build do TestFlightu,
6. otestovať na Dominikinom fyzickom iPhone.

## 11. Povinné testy na reálnych telefónoch

- Ivan → Ivan: push iba Ivanovi.
- Ivan → Dominika: push iba Dominike.
- Dominika → Ivan: push iba Ivanovi.
- Dominika → Dominika: push iba Dominike.
- Checkbox potvrdenia zapnutý: autor dostane jednu správu po splnení.
- Checkbox vypnutý: autor nedostane potvrdenie.
- „OK – počul som“ zastaví opakovania, úloha zostane nesplnená.
- „Hotovo“ zastaví opakovania a označí úlohu za splnenú.
- Snooze vytvorí nový alarmový cyklus.
- Zmena času zruší staré jobs a vytvorí nové.
- Odhlásenie bezpečne deaktivuje subscription pred zrušením relácie.
- Android aplikácia zatvorená a obrazovka zamknutá.
- iPhone aplikácia zatvorená a obrazovka zamknutá.
- iPhone Focus/Time Sensitive nastavenia.
- dočasný výpadok internetu a následná synchronizácia.


## 12. Upgrade existujúceho testovacieho backendu na v0.2.2

Ak sú tabuľky a účty už vytvorené:

1. v Supabase SQL Editore spusti celý súbor `supabase/migrations/004_deep_audit_fixes.sql`,
2. over, že SQL skončilo bez chyby,
3. znova nasaď `push-worker`,
4. zostav a nainštaluj APK s `versionCode 3`,
5. pred testom odinštaluj starú testovaciu APK alebo vymaž jej dáta, aby v telefóne nezostala stará relácia a starý JS bundle.

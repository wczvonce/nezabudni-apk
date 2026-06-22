# Presné ďalšie kroky

## 1. Supabase databáza

V novom projekte `ofwouqpqzcpjnigcgygz` otvor SQL Editor a spusti:

1. `supabase/migrations/001_schema.sql`
2. v Authentication → Users vytvor:
   - `wczvonce@gmail.com` – Ivan Povrazník
   - `domi.mikloskova@gmail.com` – Dominika
3. `supabase/migrations/002_setup_pair_template.sql`

## 2. Tajné hodnoty

Vygeneruj dlhý náhodný `PUSH_WORKER_SECRET`. OneSignal REST API key a tento secret nevkladaj do kódu.

```bash
supabase login
supabase link --project-ref ofwouqpqzcpjnigcgygz
supabase secrets set ONESIGNAL_REST_API_KEY="..."
supabase secrets set ONESIGNAL_APP_ID="6b9193d7-db17-4e17-9320-4dcb7c410e76"
supabase secrets set PUSH_WORKER_SECRET="..."
```

## 3. Edge Function

```bash
supabase functions deploy push-worker --no-verify-jwt
```

Funkcia je chránená samostatnou hlavičkou `x-worker-secret`.

## 4. Cron

V `supabase/migrations/003_cron_template.sql` nahraď:

- `YOUR_PROJECT_REF` → `ofwouqpqzcpjnigcgygz`
- `REPLACE_WITH_LONG_RANDOM_SECRET` → rovnaký `PUSH_WORKER_SECRET`

Potom skript spusti v SQL Editore. Upravený skript so secretom neukladaj do ZIP-u ani GitHubu.

## 5. Nový Netlify projekt

Vytvor novú stránku, nie deploy do starej `magenta-palmier-e4333d.netlify.app`.

- Build command: `npm run build`
- Publish directory: `dist`

Verejné identifikátory sú už zabudované. Netlify environment variables sú voliteľné a môžu ich prepísať.

## 6. Android test

```bash
npm ci
npm run audit
npx cap sync android
npx cap open android
```

Na fyzickom Androide sa prihlás ako Ivan, povoľ upozornenia a použi testovacie tlačidlo.

## 7. iPhone

APNs zatiaľ nie je nastavené. Najprv treba Apple Developer účet, APNs p8 kľúč v OneSignal a podpis projektu cez Xcode/TestFlight.

# Prepojené testovacie služby

Tieto hodnoty sú verejné a sú už zapracované do frontendu.

- Supabase Project Ref: `ofwouqpqzcpjnigcgygz`
- Supabase Project URL: `https://ofwouqpqzcpjnigcgygz.supabase.co`
- Supabase publishable key: `sb_publishable_q5xQ1rNFeYQsuUtjXllIvg_aJft17Qy`
- Firebase Project ID: `nezabudni-testovacia`
- OneSignal App ID: `6b9193d7-db17-4e17-9320-4dcb7c410e76`
- Android Application ID: `sk.povraznik.nezabudni.test`
- FCM v1 v OneSignal: aktívne
- iOS/APNs: zatiaľ nenastavené

## Tajné údaje, ktoré nesmú byť v projekte

- Supabase database password
- Supabase service-role/secret key
- Firebase Service Account JSON
- OneSignal REST API key
- `PUSH_WORKER_SECRET`
- Apple APNs p8 private key

## Ďalší bezpečný krok

1. Spustiť SQL migráciu `001_schema.sql`.
2. Vytvoriť oba Auth účty.
3. Spustiť `002_setup_pair_template.sql`.
4. Nastaviť Edge Function secrets priamo v Supabase.
5. Nasadiť `push-worker`.
6. Spustiť upravený Cron skript.
7. Nasadiť nový samostatný Netlify projekt.

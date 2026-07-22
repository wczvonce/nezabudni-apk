# ChatGPT Action pre Nezabudni – bezpečné nasadenie a test

Táto integrácia je **voliteľná a izolovaná**. Nemení existujúci mobilný ani webový tok vytvárania úloh, offline outbox, Realtime alebo OneSignal worker. Pridáva iba nový, úzko obmedzený vstup pre súkromný GPT.

Po dokončení bude fungovať napríklad veta:

> Zapíš úlohu do Nezabudni pre Dominiku, aby vysypala smeti dnes o 22:00, a upozorni ma, keď bude splnená.

GPT najprv ukáže presné zhrnutie a počká na výslovné potvrdenie. Až potom vytvorí úlohu. Pole `notify_creator_on_complete` sa uloží ako `true`, takže po Dominikinom splnení existujúca logika Nezabudni vytvorí upozornenie pre Ivana.

## Bezpečnostný model

```text
Súkromný GPT + Action
        │ x-nezabudni-action-key
        ▼
Supabase Edge Function chatgpt-api
        │ SHA-256 overenie tokenu
        ▼
service-role RPC api_create_task_from_integration
        │ kontrola aktéra, dvojice, príjemcu, limitov a idempotencie
        ▼
tasks + task_events + notification_jobs
        ▼
existujúci Realtime + OneSignal push-worker
        ▼
Nezabudni v mobile
```

ChatGPT nikdy nedostane Supabase `service_role` kľúč. Konektorový token:

- má 256 bitov náhodnosti,
- je viazaný na konkrétne UUID používateľa,
- v databáze sa uchováva iba jeho SHA-256 hash,
- povoľuje iba operáciu `create_task`,
- štandardne platí 180 dní,
- dá sa okamžite deaktivovať,
- má limit 5 nových úloh za minútu a 100 za 24 hodín.

## Ako sa rieši čas

GPT neposiela UTC offset. Posiela iba:

```json
{
  "local_date": "YYYY-MM-DD",
  "local_time": "HH:MM",
  "timezone": "Europe/Bratislava"
}
```

Správny letný alebo zimný čas vypočíta server podľa IANA časovej zóny. Tým sa odstráni riziko posunu o hodinu.

- Ak čas pri jarnej zmene hodiniek neexistuje, API vráti `NONEXISTENT_LOCAL_TIME`.
- Ak čas pri jesennej zmene nastane dvakrát, API vráti `AMBIGUOUS_LOCAL_TIME` a GPT sa opýta na skorší alebo neskorší výskyt.

# Časť A – kontrola kódu pred nasadením

## 1. Nezlučuj draft PR naslepo

Najprv musí prejsť GitHub CI:

- všetky pôvodné testy aplikácie,
- SQL migrácie,
- serverové testy časového pásma,
- end-to-end SQL test upozornenia autora po splnení,
- `deno check` novej Edge Function,
- Vite build,
- Android debug build,
- dependency security audit.

## 2. Lokálny audit

Potrebné nástroje:

- Node.js 22,
- npm,
- Deno 2.8.1,
- Supabase CLI pre neskoršie nasadenie.

Spusti:

```bash
npm ci
npm run audit
npm audit --audit-level=high
```

`npm run audit` teraz zahŕňa aj:

```bash
deno check supabase/functions/chatgpt-api/index.ts
node tests/chatgpt-timezone.test.mjs
node tests/chatgpt-integration-sql.test.mjs
```

Nezlučuj ani nenasadzuj, ak niektorý príkaz skončí chybou.

# Časť B – nasadenie do Supabase

## 3. Najprv záloha

Pred migráciou:

1. vytvor zálohu alebo export databázovej schémy,
2. over, že sú nasadené migrácie `001`, `004` až `011`,
3. over, že existujúce Nezabudni normálne vytvára, synchronizuje a dokončuje úlohy.

## 4. Spusti migráciu 012

V Supabase SQL Editore spusti celý súbor:

```text
supabase/migrations/012_chatgpt_action_integration.sql
```

Migrácia pridáva iba:

- `integration_clients`,
- `integration_requests`,
- `api_create_task_from_integration`,
- capability handshake `schema_version: 12`.

Nemení tabuľku `tasks`, existujúcu `api_create_task`, mobilný klient ani `push-worker`.

Po migrácii over:

```sql
select public.get_backend_capabilities();
```

Očakávaný výsledok obsahuje:

```json
{"schema_version": 12}
```

## 5. Zisti presné UUID Ivana

V SQL Editore spusti:

```sql
select id, display_name, email
from public.profiles
order by display_name;
```

Skopíruj UUID riadku Ivana. Na registráciu konektora nepoužívaj e-mail ako identifikátor.

## 6. Vygeneruj jednorazový token

Lokálne v repozitári spusti:

```bash
npm run chatgpt:token
```

Skript vypíše:

- tajný token – vloží sa iba do nastavenia GPT Action,
- SHA-256 hash – uloží sa do Supabase.

Tajný token odlož do správcu hesiel. Necommituj ho, neposielaj e-mailom a nevkladaj do frontendového `.env`.

## 7. Zaregistruj konektor

Nahraď dve zástupné hodnoty:

```sql
insert into public.integration_clients(
  name,
  actor_id,
  token_hash,
  allowed_operations,
  expires_at,
  max_per_minute,
  max_per_day
) values (
  'ChatGPT – Ivan',
  '<IVAN_PROFILE_UUID>'::uuid,
  '<SHA256_HASH_TOKENU>',
  array['create_task']::text[],
  now() + interval '180 days',
  5,
  100
)
returning id, name, actor_id, active, expires_at, max_per_minute, max_per_day;
```

Bezpečne si odlož vrátené `id` konektora. Bude sa používať na deaktiváciu a rotáciu.

## 8. Nasaď Edge Function

```bash
supabase link --project-ref ofwouqpqzcpjnigcgygz
supabase functions deploy chatgpt-api --no-verify-jwt
```

Hostované Supabase prostredie poskytne funkcii `SUPABASE_URL` a `SUPABASE_SERVICE_ROLE_KEY`. Service-role kľúč nevkladaj do GitHubu ani do ChatGPT.

# Časť C – technický test bez ChatGPT

## 9. Test kontextu bez zápisu

```bash
curl \
  -H 'x-nezabudni-action-key: <TAJNY_TOKEN>' \
  'https://ofwouqpqzcpjnigcgygz.supabase.co/functions/v1/chatgpt-api/context'
```

Očakávaj:

- `ok: true`,
- správne meno Ivana,
- správne meno Dominiky,
- `timezone: Europe/Bratislava`,
- správny miestny dátum a čas,
- žiadne e-mailové adresy ani interné UUID osôb.

## 10. Test jednej úlohy

Vyber dátum a čas aspoň 10 minút v budúcnosti a vytvor nové UUID:

```bash
curl -X POST \
  -H 'content-type: application/json' \
  -H 'x-nezabudni-action-key: <TAJNY_TOKEN>' \
  'https://ofwouqpqzcpjnigcgygz.supabase.co/functions/v1/chatgpt-api/reminders' \
  --data '{
    "request_id": "<NOVE_UUID>",
    "title": "Vysypať smeti",
    "notes": null,
    "local_date": "<BUDUCI_DATUM_YYYY-MM-DD>",
    "local_time": "<BUDUCI_CAS_HH:MM>",
    "timezone": "Europe/Bratislava",
    "assignee": "partner",
    "priority": 1,
    "pre_reminder_minutes": 0,
    "recurrence_rule": "none",
    "recurrence_mode": "after",
    "notify_creator_on_complete": true,
    "reminder_interval_seconds": 60,
    "max_reminders": 10
  }'
```

Očakávaj:

- HTTP 200,
- `ok: true`,
- ID úlohy,
- správny miestny dátum a čas,
- správny automaticky vypočítaný `utc_offset`,
- `assigned_to.display_name` je Dominika,
- `notify_creator_on_complete` je `true`.

## 11. Povinný test idempotencie

Pošli úplne rovnakú požiadavku druhýkrát s rovnakým `request_id`.

Očakávaj:

- rovnaké ID úlohy,
- v Nezabudni nevznikne druhá úloha.

Potom zmeň názov, ale ponechaj rovnaký `request_id`.

Očakávaj HTTP 409 a kód:

```text
IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
```

## 12. Povinný test upozornenia po splnení

1. Ivan vytvorí skúšobnú úlohu pre Dominiku s `notify_creator_on_complete: true`.
2. Dominika otvorí Nezabudni a označí ju ako hotovú.
3. Over, že Ivan dostane presne jedno upozornenie o splnení.
4. Over, že opakované stlačenie alebo synchronizačný retry nevytvorí druhé upozornenie.

Automatický SQL test tejto funkcie je v:

```text
tests/chatgpt-integration-sql.test.mjs
```

# Časť D – vytvorenie súkromného GPT

## 13. Action schéma

V editore vlastného GPT importuj:

```text
docs/chatgpt-action-openapi.yaml
```

Nastav autentifikáciu:

- typ: **API Key**,
- spôsob: **Custom header**,
- názov hlavičky: `x-nezabudni-action-key`,
- hodnota: tajný token.

GPT nechaj súkromný.

## 14. Inštrukcie GPT

Do poľa Instructions vlož obsah:

```text
docs/CHATGPT-GPT-INSTRUCTIONS-SK.md
```

Tieto inštrukcie vyžadujú výslovné potvrdenie pred každým zápisom.

## 15. Reálny používateľský test

Do textového poľa vlastného GPT nadiktuj:

> Zapíš úlohu do Nezabudni pre Dominiku, aby vysypala smeti dnes o 22:00, a upozorni ma, keď bude úloha splnená.

Správny priebeh:

1. GPT načíta kontext.
2. GPT presne zopakuje názov, Dominiku, dátum, čas a upozornenie po splnení.
3. GPT sa opýta, či má úlohu zapísať.
4. Pred tvojím „áno“ sa v aplikácii nič nevytvorí.
5. Po „áno“ Action vráti `ok: true` a úloha sa objaví v Nezabudni.
6. Dominika dostane upozornenie podľa existujúceho systému.
7. Po splnení dostane Ivan upozornenie.

Vlastné GPT Actions nie sú dostupné počas samostatnej živej Voice konverzácie. Použi mikrofón pri bežnom textovom poli, skontroluj prepis a správu odošli.

# Okamžité vypnutie

Použi presné UUID konektora:

```sql
update public.integration_clients
set active = false
where id = '<INTEGRATION_CLIENT_ID>'::uuid;
```

Tým sa ďalšie požiadavky okamžite odmietnu. Existujúce úlohy a mobilná aplikácia zostanú nedotknuté.

# Rotácia po expirácii alebo podozrení na únik

1. Vygeneruj nový token.
2. Vytvor nový riadok `integration_clients` s novým hashom.
3. V ChatGPT Action nahraď tajnú hodnotu novým tokenom.
4. Otestuj `/context` a jednu skúšobnú úlohu.
5. Starý konektor deaktivuj podľa jeho UUID.

Nikdy neprepisuj starý token skôr, než nový konektor úspešne prejde testom.

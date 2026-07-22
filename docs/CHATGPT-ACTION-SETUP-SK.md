# ChatGPT Action pre Nezabudni – nasadenie a audit

Táto integrácia je **voliteľná a izolovaná**. Nemení existujúci webový ani mobilný tok vytvárania úloh, offline outbox, Realtime ani OneSignal worker. Pridáva iba nový, úzko obmedzený vstup pre súkromný GPT.

## Čo bude fungovať

Po nasadení môže používateľ do svojho súkromného GPT nadiktovať do textového poľa napríklad:

> Zapíš úlohu do Nezabudni pre Dominiku, aby vysypala smeti dnes o 22:00, a upozorni ma, keď bude splnená.

GPT načíta kontext dvojice, pripraví presný dátum a čas, vypýta si potvrdenie a vytvorí úlohu. Pole `notify_creator_on_complete` sa uloží ako `true`, takže existujúca logika Nezabudni upozorní autora po splnení úlohy partnerom.

## Prečo je prvá verzia autentifikovaná konektorovým tokenom

GPT Actions oficiálne podporujú vlastný API kľúč v hlavičke. Supabase OAuth Server je stále beta a vyžaduje OAuth 2.1 Authorization Code Flow s PKCE. Kým nie je prakticky potvrdená kompatibilita konkrétneho GPT Action OAuth klienta s povinným PKCE tokom, je pre túto súkromnú dvojicu spoľahlivejší revokovateľný 256-bitový konektorový token.

Token:

- je náhodný a viazaný na jedného používateľa Nezabudni,
- v databáze sa ukladá iba jeho SHA-256 hash,
- má iba operáciu `create_task`,
- dá sa okamžite deaktivovať,
- nikdy sa neukladá do aplikácie, GitHubu ani frontendového `.env`,
- v ChatGPT sa uloží ako tajná hodnota Action autentifikácie.

Architektúra je pripravená tak, aby sa autentifikácia neskôr dala vymeniť za OAuth bez zmeny existujúceho systému úloh a notifikácií.

## Architektúra

```text
Súkromný GPT + Action
        │ x-nezabudni-action-key
        ▼
Supabase Edge Function chatgpt-api
        │ overenie SHA-256 tokenu a mapovanie na actor_id
        ▼
service-role RPC api_create_task_from_integration
        │ kontrola dvojice, idempotencie, limitu a vstupov
        ▼
tasks + task_events + notification_jobs
        ▼
existujúci Supabase Realtime + OneSignal push-worker
        ▼
Nezabudni v mobile
```

ChatGPT nemá prístup k service-role kľúču. Ten zostáva iba v serverovom prostredí Supabase Edge Functions.

# Bezpečné poradie nasadenia

## 1. Najprv záloha a audit

Pred zásahom do testovacieho Supabase projektu:

1. exportuj databázovú schému alebo vytvor zálohu,
2. over, že sú nasadené migrácie `001`, `004` až `011`,
3. spusti v repozitári:

```bash
npm ci
npm run audit
```

## 2. Spusti migráciu 012

V Supabase SQL Editore spusti celý súbor:

```text
supabase/migrations/012_chatgpt_action_integration.sql
```

Migrácia iba pridáva:

- `integration_clients`,
- `integration_requests`,
- `api_create_task_from_integration`.

Nemení existujúcu `api_create_task`, tabuľku `tasks`, mobilnú aplikáciu ani push worker.

## 3. Vygeneruj jednorazový token

Lokálne v repozitári spusti:

```bash
npm run chatgpt:token
```

Skript vypíše:

- tajný token – vloží sa neskôr iba do nastavenia GPT Action,
- SHA-256 hash – uloží sa do Supabase.

Tajný token si dočasne odlož do správcu hesiel. Po zatvorení terminálu ho zo Supabase nezískaš, pretože databáza uchováva iba hash.

## 4. Zaregistruj konektor pre používateľa

V SQL Editore nahraď zástupné hodnoty a spusti:

```sql
insert into public.integration_clients(name, actor_id, token_hash, allowed_operations)
select
  'ChatGPT – súkromný konektor',
  id,
  '<SHA256_HASH_Z_PREDCHADZAJUCEHO_KROKU>',
  array['create_task']::text[]
from public.profiles
where email = '<EMAIL_POUZIVATELA_NEZABUDNI>'
on conflict (token_hash) do update
set active = true,
    actor_id = excluded.actor_id,
    name = excluded.name,
    allowed_operations = excluded.allowed_operations;
```

Potom over presne jeden aktívny riadok:

```sql
select id, name, actor_id, active, allowed_operations, created_at
from public.integration_clients;
```

Token hash ani výsledok tohto dotazu nevkladaj do verejnej dokumentácie.

## 5. Nasaď Edge Function

`supabase/config.toml` obsahuje pre `chatgpt-api` nastavenie `verify_jwt = false`, pretože funkcia používa vlastný tajný token a nie používateľský Supabase JWT.

```bash
supabase link --project-ref ofwouqpqzcpjnigcgygz
supabase functions deploy chatgpt-api --no-verify-jwt
```

Funkcia používa serverové premenné `SUPABASE_URL` a `SUPABASE_SERVICE_ROLE_KEY`, ktoré sú v hostovanom Supabase prostredí dostupné funkciám. Žiadny nový service-role kľúč nevkladaj do repozitára.

## 6. Otestuj kontext bez zápisu

```bash
curl \
  -H 'x-nezabudni-action-key: <TAJNY_TOKEN>' \
  'https://ofwouqpqzcpjnigcgygz.supabase.co/functions/v1/chatgpt-api/context'
```

Očakávaj `ok: true`, aktuálny serverový čas a správne mená používateľa a partnera.

## 7. Otestuj jednu skúšobnú úlohu

Použi nové UUID a termín v budúcnosti:

```bash
curl -X POST \
  -H 'content-type: application/json' \
  -H 'x-nezabudni-action-key: <TAJNY_TOKEN>' \
  'https://ofwouqpqzcpjnigcgygz.supabase.co/functions/v1/chatgpt-api/reminders' \
  --data '{
    "request_id": "4f994f18-1fd7-4c4d-9944-a4454e681a22",
    "title": "Vysypať smeti",
    "notes": null,
    "due_at": "2026-07-22T22:00:00+02:00",
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

Pri reálnom teste zmeň dátum na budúci termín. Over:

1. odpoveď obsahuje `ok: true` a ID úlohy,
2. úloha sa zobrazí partnerovi,
3. partner dostane existujúcu notifikáciu o priradenej úlohe,
4. pri termíne príde existujúce upozornenie,
5. po označení úlohy ako hotovej dostane autor upozornenie.

### Povinný test idempotencie

Pošli úplne rovnaký request druhýkrát s rovnakým `request_id`. Odpoveď musí vrátiť rovnaké ID úlohy a v databáze nesmie pribudnúť duplikát.

Potom zmeň názov, ale ponechaj rovnaký `request_id`. API musí vrátiť HTTP 409 s kódom `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.

## 8. Vytvor súkromný GPT

V ChatGPT otvor editor vlastného GPT a nechaj GPT súkromný.

### Action schéma

Importuj obsah:

```text
docs/chatgpt-action-openapi.yaml
```

### Autentifikácia

Nastav:

- typ: **API Key**,
- spôsob: **Custom header**,
- názov hlavičky: `x-nezabudni-action-key`,
- hodnota: tajný token z kroku 3.

### Inštrukcie GPT

Do poľa Instructions vlož obsah:

```text
docs/CHATGPT-GPT-INSTRUCTIONS-SK.md
```

V Preview najprv otestuj neškodné načítanie kontextu a až potom skúšobný zápis.

## 9. Používanie

V bežnom textovom chate vlastného GPT stlač mikrofón pri textovom poli, nadiktuj vetu a odošli prepísaný text. Napríklad:

> Zapíš úlohu do Nezabudni pre Dominiku, aby vysypala smeti dnes o 22:00, a upozorni ma, keď bude úloha splnená.

GPT má najprv ukázať presné zhrnutie. Po potvrdení zavolá Action. Úlohu smie označiť ako zapísanú až po úspešnej odpovedi servera.

Vlastné GPT Actions nemusia byť dostupné priamo počas samostatného živého Voice režimu. Spoľahlivý tok je diktovanie do textového poľa vlastného GPT.

# Ochrany proti poškodeniu existujúcej aplikácie

- Nová Edge Function má vlastný názov a vlastnú cestu.
- Existujúci `push-worker` sa nemení.
- Existujúce klientské RPC sa nemenia.
- ChatGPT nemá priame práva na tabuľku `tasks`.
- Token je viazaný na konkrétne `actor_id`.
- Príjemca musí byť členom rovnakej dvojice.
- Jedna dvojica musí mať presne jedného partnera.
- Rovnaký `request_id` je idempotentný.
- Rovnaký `request_id` s iným obsahom je odmietnutý.
- Limit je 20 nových úloh za minútu na konektor.
- Termín nemôže byť viac než 5 minút v minulosti ani viac než 10 rokov v budúcnosti.
- Vstupy majú rovnaké hranice ako existujúca aplikácia.
- Udalosť sa zapisuje do `task_events` so zdrojom `chatgpt_action`.
- Tajný token sa v databáze uchováva iba ako SHA-256 hash.

# Okamžité vypnutie a rollback

Najrýchlejšie vypnutie bez zásahu do aplikácie:

```sql
update public.integration_clients
set active = false
where name = 'ChatGPT – súkromný konektor';
```

Tým sa ďalšie požiadavky okamžite odmietnu. Existujúce úlohy a mobilná aplikácia zostanú nedotknuté.

Edge Function môžeš následne odstrániť alebo nechať nasadenú s deaktivovaným klientom. Migráciu netreba vracať späť, pretože jej objekty sú izolované a bez aktívneho klienta nepoužiteľné.

# Budúce OAuth rozšírenie

Keď bude prakticky potvrdená kompatibilita GPT Actions s povinným PKCE tokom Supabase OAuth 2.1 Servera, možno pridať OAuth vrstvu. Business logika úloh, idempotencia, Realtime aj notifikácie sa pritom nemusia meniť.

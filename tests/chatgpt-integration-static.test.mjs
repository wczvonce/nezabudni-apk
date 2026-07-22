import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const edge = await readFile('supabase/functions/chatgpt-api/index.ts', 'utf8');
const migration = await readFile('supabase/migrations/012_chatgpt_action_integration.sql', 'utf8');
const schema = await readFile('docs/chatgpt-action-openapi.yaml', 'utf8');
const config = await readFile('supabase/config.toml', 'utf8');
const tokenScript = await readFile('scripts/create-chatgpt-token.mjs', 'utf8');

// Edge Function: vlastný revokovateľný token, iba hash v DB, žiadny priamy zápis do tasks.
assert.match(edge, /x-nezabudni-action-key/, 'Action musí používať samostatnú tajnú hlavičku');
assert.match(edge, /crypto\.subtle\.digest\('SHA-256'/, 'Token sa musí pred DB lookupom hashovať');
assert.match(edge, /\.from\('integration_clients'\)/, 'Token musí byť mapovaný cez integration_clients');
assert.match(edge, /\.rpc\('api_create_task_from_integration'/, 'Zápis musí ísť cez izolované RPC');
assert.doesNotMatch(edge, /\.from\('tasks'\)[\s\S]{0,120}\.insert\(/, 'Edge Function nesmie zapisovať priamo do tasks');
assert.doesNotMatch(edge, /Access-Control-Allow-Origin[^\n]*\*/, 'Action API nesmie mať CORS wildcard');
assert.match(edge, /UNKNOWN_FIELDS/, 'Neznáme polia musia byť odmietnuté');
assert.match(edge, /RFC3339_WITH_ZONE_RE/, 'Termín musí obsahovať explicitné časové pásmo');
assert.match(edge, /payloadHash/, 'Request musí mať stabilný payload hash');
assert.match(edge, /request_id/, 'Request musí používať idempotency request_id');
assert.match(edge, /notify_creator_on_complete/, 'Action musí podporovať upozornenie autora po splnení');
assert.match(edge, /loadPairContext/, 'Príjemca musí byť vyriešený z DB kontextu dvojice');
assert.match(edge, /allowed_operations.*create_task|includes\('create_task'\)/s, 'Konektor musí mať explicitne povolenú operáciu create_task');

// SQL: izolované tabuľky, revokované klientské práva, kontrola identity a idempotencie.
assert.match(migration, /create table if not exists public\.integration_clients/, 'Chýba integration_clients');
assert.match(migration, /token_hash text not null unique/, 'Hash tokenu musí byť unikátny');
assert.match(migration, /create table if not exists public\.integration_requests/, 'Chýba integration_requests');
assert.match(migration, /primary key \(client_id, request_id\)/, 'Idempotencia musí byť per client + request');
assert.match(migration, /revoke all on public\.integration_clients from public, anon, authenticated/, 'Tokenové dáta nesmú byť dostupné klientom');
assert.match(migration, /grant execute on function public\.api_create_task_from_integration[\s\S]*to service_role/, 'Integračné RPC smie volať iba service_role');
assert.match(migration, /v_client\.actor_id <> p_actor_id/, 'RPC musí kontrolovať mapovanie tokenu na aktéra');
assert.match(migration, /v_existing\.payload_hash <> p_payload_hash/, 'RPC musí odmietnuť reuse request_id s iným obsahom');
assert.match(migration, /v_recent_count >= 20/, 'RPC musí mať ochranný rate limit');
assert.match(migration, /pair_id = v_pair and user_id = p_assigned_to/, 'Príjemca musí byť členom rovnakej dvojice');
assert.match(migration, /perform public\.enqueue_task_notification_jobs\(v_task\)/, 'Nová úloha musí použiť existujúcu notifikačnú frontu');
assert.match(migration, /'task_assigned'/, 'Partner musí dostať existujúcu notifikáciu o priradení');
assert.match(migration, /p_notify_creator_on_complete/, 'RPC musí zachovať checkbox upozornenia autora');
assert.match(migration, /'source', 'chatgpt_action'/, 'Audit event musí označiť integračný zdroj');
assert.doesNotMatch(migration, /alter table public\.tasks/, 'Migrácia nesmie meniť existujúcu tabuľku tasks');
assert.doesNotMatch(migration, /create or replace function public\.api_create_task\s*\(/, 'Migrácia nesmie meniť existujúce klientské api_create_task');

// OpenAPI: private API key + dôsledková operácia + kontext pred zápisom.
assert.match(schema, /type: apiKey/, 'OpenAPI musí používať API key auth');
assert.match(schema, /name: x-nezabudni-action-key/, 'OpenAPI hlavička sa musí zhodovať s Edge Function');
assert.match(schema, /operationId: getNezabudniContext/, 'OpenAPI musí poskytovať bezpečný kontext');
assert.match(schema, /operationId: createNezabudniReminder/, 'OpenAPI musí poskytovať create operáciu');
assert.match(schema, /x-openai-isConsequential: true/, 'Zápis musí byť označený ako dôsledková operácia');
assert.match(schema, /notify_creator_on_complete/, 'OpenAPI musí vystaviť existujúcu funkciu upozornenia autora');
assert.match(schema, /additionalProperties: false/, 'Create payload nesmie prijímať ľubovoľné polia');

// Funkcia je zámerne bez JWT gateway checku, lebo používa vlastný tajný token.
assert.match(config, /\[functions\.chatgpt-api\][\s\S]*verify_jwt\s*=\s*false/, 'chatgpt-api musí mať explicitnú auth konfiguráciu');

// Generátor musí používať kryptograficky bezpečný token a vypísať iba hash na uloženie.
assert.match(tokenScript, /randomBytes\(32\)/, 'Token musí mať 256 bitov náhodnosti');
assert.match(tokenScript, /createHash\('sha256'\)/, 'Skript musí pripraviť SHA-256 hash');

console.log('CHATGPT INTEGRATION STATIC OK');

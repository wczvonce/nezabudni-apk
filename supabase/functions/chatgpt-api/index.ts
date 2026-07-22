import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

const TOKEN_HEADER = 'x-nezabudni-action-key';
const DEFAULT_TIMEZONE = 'Europe/Bratislava';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const CREATE_KEYS = new Set([
  'request_id',
  'title',
  'notes',
  'due_at',
  'timezone',
  'assignee',
  'priority',
  'pre_reminder_minutes',
  'recurrence_rule',
  'recurrence_mode',
  'notify_creator_on_complete',
  'reminder_interval_seconds',
  'max_reminders',
]);

type IntegrationClient = {
  id: string;
  actor_id: string;
  name: string;
  active: boolean;
  allowed_operations: string[];
};

type Profile = {
  id: string;
  display_name: string;
  email: string;
};

type ReminderInput = {
  request_id: string;
  title: string;
  notes: string | null;
  due_at: string;
  timezone: string;
  assignee: 'self' | 'partner';
  priority: number;
  pre_reminder_minutes: number;
  recurrence_rule: 'none' | 'daily' | 'weekly' | 'monthly';
  recurrence_mode: 'after' | 'each';
  notify_creator_on_complete: boolean;
  reminder_interval_seconds: number;
  max_reminders: number;
};

class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function mustEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const supabaseAdmin = createClient(
  mustEnv('SUPABASE_URL'),
  mustEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function tokenFrom(request: Request): string {
  const token = request.headers.get(TOKEN_HEADER)?.trim() ?? '';
  if (token.length < 32 || token.length > 512) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Neplatné alebo chýbajúce pripojenie k Nezabudni.');
  }
  return token;
}

async function authenticate(request: Request): Promise<IntegrationClient> {
  const tokenHash = await sha256Hex(tokenFrom(request));
  const { data, error } = await supabaseAdmin
    .from('integration_clients')
    .select('id,actor_id,name,active,allowed_operations')
    .eq('token_hash', tokenHash)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error('Integration client lookup failed', error.message);
    throw new ApiError(500, 'AUTH_LOOKUP_FAILED', 'Overenie pripojenia dočasne zlyhalo.');
  }
  if (!data) throw new ApiError(401, 'UNAUTHORIZED', 'Neplatné alebo zrušené pripojenie k Nezabudni.');
  return data as IntegrationClient;
}

async function loadPairContext(admin: SupabaseClient, actorId: string): Promise<{
  pairId: string;
  actor: Profile;
  partner: Profile;
}> {
  const { data: membership, error: membershipError } = await admin
    .from('pair_members')
    .select('pair_id')
    .eq('user_id', actorId)
    .maybeSingle();
  if (membershipError) throw new ApiError(500, 'PAIR_LOOKUP_FAILED', 'Nepodarilo sa načítať dvojicu.');
  if (!membership?.pair_id) throw new ApiError(409, 'PAIR_NOT_CONFIGURED', 'Používateľ nemá nakonfigurovanú dvojicu.');

  const { data: memberRows, error: membersError } = await admin
    .from('pair_members')
    .select('user_id')
    .eq('pair_id', membership.pair_id)
    .order('created_at', { ascending: true });
  if (membersError) throw new ApiError(500, 'MEMBERS_LOOKUP_FAILED', 'Nepodarilo sa načítať členov dvojice.');

  const memberIds = ((memberRows ?? []) as Array<{ user_id: string }>).map((row) => row.user_id).filter(Boolean);
  const { data: profiles, error: profilesError } = await admin
    .from('profiles')
    .select('id,display_name,email')
    .in('id', memberIds);
  if (profilesError) throw new ApiError(500, 'PROFILES_LOOKUP_FAILED', 'Nepodarilo sa načítať profily.');

  const profileRows = (profiles ?? []) as Profile[];
  const byId = new Map<string, Profile>(profileRows.map((profile) => [profile.id, profile]));
  const actor = byId.get(actorId);
  const partners = memberIds.filter((id) => id !== actorId).map((id) => byId.get(id)).filter(Boolean) as Profile[];
  if (!actor) throw new ApiError(409, 'ACTOR_PROFILE_MISSING', 'Profil používateľa nie je nakonfigurovaný.');
  if (partners.length !== 1) {
    throw new ApiError(409, 'PAIR_SHAPE_UNSUPPORTED', 'ChatGPT integrácia vyžaduje presne jedného partnera.');
  }

  return { pairId: membership.pair_id, actor, partner: partners[0] };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_JSON_BODY', 'Telo požiadavky musí byť JSON objekt.');
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_FIELD', `Pole ${field} musí byť text.`);
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw new ApiError(400, 'INVALID_FIELD', `Pole ${field} musí mať ${min} až ${max} znakov.`);
  }
  return text;
}

function asNullableString(value: unknown, field: string, max: number): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_FIELD', `Pole ${field} musí byť text.`);
  const text = value.trim();
  if (text.length > max) throw new ApiError(400, 'INVALID_FIELD', `Pole ${field} je príliš dlhé.`);
  return text || null;
}

function asInteger(value: unknown, field: string, fallback: number, min: number, max: number): number {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ApiError(400, 'INVALID_FIELD', `Pole ${field} musí byť celé číslo od ${min} do ${max}.`);
  }
  return number;
}

function asBoolean(value: unknown, field: string, fallback = false): boolean {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw new ApiError(400, 'INVALID_FIELD', `Pole ${field} musí byť true alebo false.`);
  return value;
}

function asEnum<T extends string>(value: unknown, field: string, fallback: T, allowed: readonly T[]): T {
  const candidate = value == null ? fallback : value;
  if (typeof candidate !== 'string' || !allowed.includes(candidate as T)) {
    throw new ApiError(400, 'INVALID_FIELD', `Pole ${field} má nepovolenú hodnotu.`);
  }
  return candidate as T;
}

function parseReminder(value: unknown): ReminderInput {
  const body = requireObject(value);
  const unknownKeys = Object.keys(body).filter((key) => !CREATE_KEYS.has(key));
  if (unknownKeys.length) {
    throw new ApiError(400, 'UNKNOWN_FIELDS', 'Požiadavka obsahuje nepodporované polia.', { fields: unknownKeys });
  }

  const requestId = asString(body.request_id, 'request_id', 36, 36);
  if (!UUID_RE.test(requestId)) throw new ApiError(400, 'INVALID_REQUEST_ID', 'request_id musí byť UUID.');

  const dueAt = asString(body.due_at, 'due_at', 20, 40);
  if (!RFC3339_WITH_ZONE_RE.test(dueAt) || !Number.isFinite(Date.parse(dueAt))) {
    throw new ApiError(400, 'INVALID_DUE_AT', 'due_at musí byť platný RFC3339 čas s časovým pásmom.');
  }

  const timezone = asString(body.timezone ?? DEFAULT_TIMEZONE, 'timezone', 1, 80);
  if (timezone !== DEFAULT_TIMEZONE) {
    throw new ApiError(400, 'UNSUPPORTED_TIMEZONE', `Táto integrácia momentálne používa iba ${DEFAULT_TIMEZONE}.`);
  }

  return {
    request_id: requestId.toLowerCase(),
    title: asString(body.title, 'title', 1, 180),
    notes: asNullableString(body.notes, 'notes', 10000),
    due_at: new Date(dueAt).toISOString(),
    timezone,
    assignee: asEnum(body.assignee, 'assignee', 'self', ['self', 'partner'] as const),
    priority: asInteger(body.priority, 'priority', 1, 1, 3),
    pre_reminder_minutes: asInteger(body.pre_reminder_minutes, 'pre_reminder_minutes', 0, 0, 10080),
    recurrence_rule: asEnum(body.recurrence_rule, 'recurrence_rule', 'none', ['none', 'daily', 'weekly', 'monthly'] as const),
    recurrence_mode: asEnum(body.recurrence_mode, 'recurrence_mode', 'after', ['after', 'each'] as const),
    notify_creator_on_complete: asBoolean(body.notify_creator_on_complete, 'notify_creator_on_complete', false),
    reminder_interval_seconds: asInteger(body.reminder_interval_seconds, 'reminder_interval_seconds', 60, 60, 86400),
    max_reminders: asInteger(body.max_reminders, 'max_reminders', 10, 1, 50),
  };
}

async function canonicalPayloadHash(input: ReminderInput, assignedTo: string): Promise<string> {
  // Fixné poradie kľúčov je zámerné: rovnaký request_id + rovnaký význam musí
  // mať rovnaký hash bez ohľadu na poradie JSON polí od klienta.
  return sha256Hex(JSON.stringify({
    assigned_to: assignedTo,
    title: input.title,
    notes: input.notes,
    due_at: input.due_at,
    timezone: input.timezone,
    priority: input.priority,
    pre_reminder_minutes: input.pre_reminder_minutes,
    recurrence_rule: input.recurrence_rule,
    recurrence_mode: input.recurrence_mode,
    notify_creator_on_complete: input.notify_creator_on_complete,
    reminder_interval_seconds: input.reminder_interval_seconds,
    max_reminders: input.max_reminders,
  }));
}

function mapRpcError(message: string): ApiError {
  const code = message.match(/(INTEGRATION_[A-Z_]+|IDEMPOTENCY_[A-Z_]+|INVALID_[A-Z_]+|PAIR_[A-Z_]+)/)?.[1] ?? 'CREATE_FAILED';
  if (code === 'INTEGRATION_RATE_LIMITED') return new ApiError(429, code, 'Príliš veľa nových úloh. Skús to o chvíľu znova.');
  if (code === 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD') {
    return new ApiError(409, code, 'Rovnaký request_id už bol použitý s inou úlohou. Vytvor nový request_id.');
  }
  if (code === 'INTEGRATION_DISABLED' || code === 'INTEGRATION_ACTOR_MISMATCH' || code === 'INTEGRATION_OPERATION_NOT_ALLOWED') {
    return new ApiError(403, code, 'Toto pripojenie nemá povolenie vytvoriť úlohu.');
  }
  if (code.startsWith('INVALID_') || code.startsWith('PAIR_')) return new ApiError(400, code, 'Úlohu sa nepodarilo vytvoriť pre neplatné údaje.');
  return new ApiError(500, code, 'Úlohu sa momentálne nepodarilo vytvoriť.');
}

async function handleContext(client: IntegrationClient): Promise<Response> {
  const { actor, partner } = await loadPairContext(supabaseAdmin, client.actor_id);
  return json(200, {
    ok: true,
    server_now: new Date().toISOString(),
    timezone: DEFAULT_TIMEZONE,
    actor: { id: actor.id, display_name: actor.display_name },
    partner: { id: partner.id, display_name: partner.display_name },
    defaults: {
      priority: 1,
      pre_reminder_minutes: 0,
      recurrence_rule: 'none',
      recurrence_mode: 'after',
      notify_creator_on_complete: false,
      reminder_interval_seconds: 60,
      max_reminders: 10,
    },
  });
}

async function handleCreate(request: Request, client: IntegrationClient): Promise<Response> {
  if (!client.allowed_operations?.includes('create_task')) {
    throw new ApiError(403, 'OPERATION_NOT_ALLOWED', 'Pripojenie nemá povolenie vytvárať úlohy.');
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError(400, 'INVALID_JSON_BODY', 'Telo požiadavky nie je platný JSON.');
  }

  const input = parseReminder(raw);
  const { actor, partner } = await loadPairContext(supabaseAdmin, client.actor_id);
  const assignee = input.assignee === 'self' ? actor : partner;
  const payloadHash = await canonicalPayloadHash(input, assignee.id);

  const { data, error } = await supabaseAdmin.rpc('api_create_task_from_integration', {
    p_client_id: client.id,
    p_actor_id: actor.id,
    p_request_id: input.request_id,
    p_payload_hash: payloadHash,
    p_id: crypto.randomUUID(),
    p_assigned_to: assignee.id,
    p_title: input.title,
    p_notes: input.notes,
    p_due_at: input.due_at,
    p_timezone: input.timezone,
    p_priority: input.priority,
    p_pre_reminder_minutes: input.pre_reminder_minutes,
    p_recurrence_rule: input.recurrence_rule,
    p_recurrence_mode: input.recurrence_mode,
    p_notify_creator_on_complete: input.notify_creator_on_complete,
    p_reminder_interval_seconds: input.reminder_interval_seconds,
    p_max_reminders: input.max_reminders,
  });

  if (error) {
    console.error('ChatGPT create RPC failed', { code: error.code, message: error.message });
    throw mapRpcError(error.message);
  }

  const task = Array.isArray(data) ? data[0] : data;
  if (!task?.id) throw new ApiError(500, 'EMPTY_CREATE_RESULT', 'Server nevytvoril platnú úlohu.');

  return json(200, {
    ok: true,
    request_id: input.request_id,
    task: {
      id: task.id,
      title: task.title,
      due_at: task.due_at,
      timezone: task.timezone,
      assigned_to: { id: assignee.id, display_name: assignee.display_name },
      created_by: { id: actor.id, display_name: actor.display_name },
      notify_creator_on_complete: Boolean(task.notify_creator_on_complete),
      recurrence_rule: task.recurrence_rule,
      status: task.status,
    },
    confirmation: `Úloha „${task.title}“ bola zapísaná pre ${assignee.display_name}.`,
  });
}

Deno.serve(async (request) => {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (request.method === 'OPTIONS') {
      // GPT Action je server-to-server a CORS nepotrebuje. Explicitne ho
      // nepovoľujeme pre ľubovoľné weby, aby token nebolo možné zneužiť z browsera.
      return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'CORS pre túto funkciu nie je povolený.' } });
    }

    const client = await authenticate(request);

    if (request.method === 'GET' && path.endsWith('/context')) return await handleContext(client);
    if (request.method === 'POST' && path.endsWith('/reminders')) return await handleCreate(request, client);

    return json(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Neznáma cesta.' } });
  } catch (error) {
    if (error instanceof ApiError) {
      return json(error.status, {
        ok: false,
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
    }
    console.error('Unhandled chatgpt-api error', error instanceof Error ? error.message : String(error));
    return json(500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Interná chyba integrácie.' } });
  }
});

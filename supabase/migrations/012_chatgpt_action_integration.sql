-- 012: bezpečný, izolovaný vstup pre ChatGPT Action.
--
-- Táto migrácia nemení existujúce klientské RPC ani notifikačný worker.
-- ChatGPT nikdy nezapisuje priamo do tasks; Edge Function overí revokovateľný
-- konektorový token a potom zavolá jedinú service-role RPC nižšie.

create table if not exists public.integration_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  actor_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  allowed_operations text[] not null default array['create_task']::text[],
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(allowed_operations) between 1 and 20)
);

create index if not exists integration_clients_actor_idx
  on public.integration_clients(actor_id)
  where active;

create table if not exists public.integration_requests (
  client_id uuid not null references public.integration_clients(id) on delete cascade,
  request_id uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  task_id uuid references public.tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (client_id, request_id)
);

create index if not exists integration_requests_recent_idx
  on public.integration_requests(client_id, created_at desc);

alter table public.integration_clients enable row level security;
alter table public.integration_requests enable row level security;

-- Žiadny mobilný/webový klient nesmie čítať tokenové hashe ani zapisovať
-- integračné požiadavky. Prístup má iba service_role v Edge Function.
revoke all on public.integration_clients from public, anon, authenticated;
revoke all on public.integration_requests from public, anon, authenticated;
grant select, insert, update, delete on public.integration_clients to service_role;
grant select, insert, update, delete on public.integration_requests to service_role;

drop trigger if exists integration_clients_touch_updated_at on public.integration_clients;
create trigger integration_clients_touch_updated_at
before update on public.integration_clients
for each row execute function public.touch_updated_at();

create or replace function public.api_create_task_from_integration(
  p_client_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_payload_hash text,
  p_id uuid,
  p_assigned_to uuid,
  p_title text,
  p_notes text,
  p_due_at timestamptz,
  p_timezone text,
  p_priority integer,
  p_pre_reminder_minutes integer,
  p_recurrence_rule text,
  p_recurrence_mode text,
  p_notify_creator_on_complete boolean,
  p_reminder_interval_seconds integer,
  p_max_reminders integer
) returns public.tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.integration_clients;
  v_existing public.integration_requests;
  v_pair uuid;
  v_task public.tasks;
  v_recent_count bigint;
  v_title text := trim(coalesce(p_title, ''));
begin
  if p_client_id is null or p_actor_id is null or p_request_id is null or p_id is null then
    raise exception 'INVALID_INTEGRATION_REQUEST';
  end if;
  if p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_PAYLOAD_HASH';
  end if;

  -- FOR UPDATE serializuje zápisy jedného konektora. Vďaka tomu je kontrola
  -- idempotencie aj limitu deterministická aj pri paralelných retry requestoch.
  select * into v_client
  from public.integration_clients
  where id = p_client_id
  for update;

  if v_client.id is null or not v_client.active then
    raise exception 'INTEGRATION_DISABLED';
  end if;
  if v_client.actor_id <> p_actor_id then
    raise exception 'INTEGRATION_ACTOR_MISMATCH';
  end if;
  if not ('create_task' = any(v_client.allowed_operations)) then
    raise exception 'INTEGRATION_OPERATION_NOT_ALLOWED';
  end if;

  select * into v_existing
  from public.integration_requests
  where client_id = p_client_id and request_id = p_request_id;

  if v_existing.request_id is not null then
    if v_existing.payload_hash <> p_payload_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD';
    end if;
    if v_existing.task_id is null then
      raise exception 'IDEMPOTENCY_RESULT_MISSING';
    end if;
    select * into v_task from public.tasks where id = v_existing.task_id;
    if v_task.id is null then
      raise exception 'IDEMPOTENCY_RESULT_MISSING';
    end if;
    update public.integration_clients set last_used_at = now() where id = p_client_id;
    return v_task;
  end if;

  -- Poistka proti chybnému promptu alebo slučke modelu. Retry s rovnakým
  -- request_id sa vyššie vráti bez započítania ako nová úloha.
  select count(*) into v_recent_count
  from public.integration_requests
  where client_id = p_client_id and created_at > now() - interval '1 minute';
  if v_recent_count >= 20 then
    raise exception 'INTEGRATION_RATE_LIMITED';
  end if;

  select pair_id into v_pair
  from public.pair_members
  where user_id = p_actor_id;
  if v_pair is null then raise exception 'PAIR_NOT_CONFIGURED'; end if;

  if not exists (
    select 1 from public.pair_members
    where pair_id = v_pair and user_id = p_assigned_to
  ) then
    raise exception 'INVALID_ASSIGNEE';
  end if;

  if v_title = '' or char_length(v_title) > 180 then raise exception 'INVALID_TITLE'; end if;
  if p_notes is not null and char_length(p_notes) > 10000 then raise exception 'INVALID_NOTES'; end if;
  if p_due_at is null or p_due_at < now() - interval '5 minutes' or p_due_at > now() + interval '10 years' then
    raise exception 'INVALID_DUE_AT';
  end if;
  if not exists (
    select 1 from pg_timezone_names
    where name = coalesce(nullif(p_timezone, ''), 'Europe/Bratislava')
  ) then
    raise exception 'INVALID_TIMEZONE';
  end if;
  if p_priority is null or p_priority not between 1 and 3 then raise exception 'INVALID_PRIORITY'; end if;
  if p_pre_reminder_minutes is null or p_pre_reminder_minutes not between 0 and 10080 then raise exception 'INVALID_PRE_REMINDER'; end if;
  if p_recurrence_rule is null or p_recurrence_rule not in ('none', 'daily', 'weekly', 'monthly') then raise exception 'INVALID_RECURRENCE'; end if;
  if p_recurrence_mode is null or p_recurrence_mode not in ('after', 'each') then raise exception 'INVALID_RECURRENCE_MODE'; end if;
  if p_reminder_interval_seconds is null or p_reminder_interval_seconds not between 60 and 86400 then raise exception 'INVALID_REMINDER_INTERVAL'; end if;
  if p_max_reminders is null or p_max_reminders not between 1 and 50 then raise exception 'INVALID_MAX_REMINDERS'; end if;

  insert into public.integration_requests(client_id, request_id, payload_hash)
  values(p_client_id, p_request_id, p_payload_hash);

  insert into public.tasks(
    id, pair_id, created_by, assigned_to, title, notes, due_at, timezone,
    priority, pre_reminder_minutes, recurrence_rule, recurrence_mode,
    series_id, occurrence_at, notify_creator_on_complete,
    reminder_interval_seconds, max_reminders, last_changed_by
  ) values (
    p_id, v_pair, p_actor_id, p_assigned_to, v_title,
    nullif(trim(coalesce(p_notes, '')), ''), p_due_at,
    coalesce(nullif(p_timezone, ''), 'Europe/Bratislava'),
    p_priority, p_pre_reminder_minutes, p_recurrence_rule, p_recurrence_mode,
    p_id, p_due_at, coalesce(p_notify_creator_on_complete, false),
    p_reminder_interval_seconds, p_max_reminders, p_actor_id
  ) returning * into v_task;

  insert into public.task_events(task_id, pair_id, actor_id, event_type, payload)
  values(
    v_task.id,
    v_pair,
    p_actor_id,
    'created',
    jsonb_build_object(
      'source', 'chatgpt_action',
      'integration_client_id', p_client_id,
      'request_id', p_request_id
    )
  );

  if p_assigned_to <> p_actor_id then
    insert into public.notification_jobs(task_id, recipient_id, kind, scheduled_at, dedupe_key)
    values(v_task.id, p_assigned_to, 'task_assigned', now(), 'task-assigned:' || v_task.id)
    on conflict(dedupe_key) do nothing;
  end if;

  perform public.enqueue_task_notification_jobs(v_task);

  update public.integration_requests
  set task_id = v_task.id
  where client_id = p_client_id and request_id = p_request_id;

  update public.integration_clients
  set last_used_at = now()
  where id = p_client_id;

  return v_task;
end;
$$;

revoke all on function public.api_create_task_from_integration(
  uuid, uuid, uuid, text, uuid, uuid, text, text, timestamptz, text,
  integer, integer, text, text, boolean, integer, integer
) from public, anon, authenticated;

grant execute on function public.api_create_task_from_integration(
  uuid, uuid, uuid, text, uuid, uuid, text, text, timestamptz, text,
  integer, integer, text, text, boolean, integer, integer
) to service_role;

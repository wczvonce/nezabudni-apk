-- Nezabudni v19 – čistá databázová schéma
-- Spusti v novom Supabase projekte cez SQL Editor alebo Supabase CLI.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pairs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table if not exists public.pair_members (
  pair_id uuid not null references public.pairs(id) on delete cascade,
  user_id uuid not null constraint pair_members_user_id_fkey references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  primary key (pair_id, user_id),
  unique (user_id)
);

create table if not exists public.tasks (
  id uuid primary key,
  pair_id uuid not null references public.pairs(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  assigned_to uuid not null references public.profiles(id),

  title text not null check (char_length(title) between 1 and 180),
  notes text check (notes is null or char_length(notes) <= 10000),
  due_at timestamptz not null,
  timezone text not null default 'Europe/Bratislava' check (char_length(timezone) between 1 and 80),
  priority smallint not null default 1 check (priority between 1 and 3),
  pre_reminder_minutes integer not null default 0 check (pre_reminder_minutes between 0 and 10080),

  recurrence_rule text not null default 'none' check (recurrence_rule in ('none','daily','weekly','monthly')),
  recurrence_mode text not null default 'after' check (recurrence_mode in ('after','each')),
  series_id uuid not null,
  occurrence_at timestamptz not null,

  notify_creator_on_complete boolean not null default false,
  reminder_interval_seconds integer not null default 60 check (reminder_interval_seconds between 60 and 86400),
  max_reminders integer not null default 10 check (max_reminders between 1 and 50),
  reminders_sent integer not null default 0 check (reminders_sent >= 0),

  status text not null default 'pending' check (status in ('pending','completed','cancelled')),
  snoozed_until timestamptz,
  acknowledged_by uuid references public.profiles(id),
  acknowledged_at timestamptz,
  completed_by uuid references public.profiles(id),
  completed_at timestamptz,

  google_calendar_enabled boolean not null default false,
  google_event_id text,

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1,
  last_changed_by uuid not null references public.profiles(id),

  unique(series_id, occurrence_at)
);

create index if not exists tasks_pair_due_idx on public.tasks(pair_id, due_at);
create index if not exists tasks_assigned_status_idx on public.tasks(assigned_to, status, due_at) where deleted_at is null;
create index if not exists tasks_updated_idx on public.tasks(pair_id, updated_at);


-- Supabase Realtime nie je pre nové tabuľky vždy zapnutý automaticky.
do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
     and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='tasks') then
    execute 'alter publication supabase_realtime add table public.tasks';
  end if;
end $$;

create table if not exists public.task_attachments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  pair_id uuid not null references public.pairs(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  storage_path text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes between 0 and 10485760),
  created_at timestamptz not null default now()
);
create index if not exists task_attachments_task_idx on public.task_attachments(task_id);

create table if not exists public.device_subscriptions (
  subscription_id text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null check (platform in ('ios','android','web')),
  device_install_id uuid not null,
  device_name text check (device_name is null or char_length(device_name) <= 160),
  active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists device_subscriptions_user_idx on public.device_subscriptions(user_id) where active;
create index if not exists device_subscriptions_install_idx on public.device_subscriptions(user_id, device_install_id);

create table if not exists public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('task_pre','task_due','task_repeat','task_completed','task_assigned','test')),
  scheduled_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued','processing','sent','cancelled','failed')),
  dedupe_key text not null unique,
  attempt_count integer not null default 0,
  locked_at timestamptz,
  sent_at timestamptz,
  onesignal_message_id text,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists notification_jobs_ready_idx on public.notification_jobs(status, scheduled_at) where status = 'queued';

create table if not exists public.client_mutations (
  mutation_id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  operation text not null,
  task_id uuid,
  processed_at timestamptz not null default now()
);

create table if not exists public.task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks(id) on delete cascade,
  pair_id uuid not null references public.pairs(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists task_events_task_idx on public.task_events(task_id, created_at);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists device_subscriptions_touch_updated_at on public.device_subscriptions;
create trigger device_subscriptions_touch_updated_at before update on public.device_subscriptions for each row execute function public.touch_updated_at();

create or replace function public.current_pair_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select pair_id from public.pair_members where user_id = auth.uid() limit 1
$$;

revoke all on function public.current_pair_id() from public;
grant execute on function public.current_pair_id() to authenticated;

alter table public.profiles enable row level security;
alter table public.pairs enable row level security;
alter table public.pair_members enable row level security;
alter table public.tasks enable row level security;
alter table public.task_attachments enable row level security;
alter table public.device_subscriptions enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.client_mutations enable row level security;
alter table public.task_events enable row level security;

drop policy if exists profiles_pair_select on public.profiles;
create policy profiles_pair_select on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.pair_members pm
    where pm.pair_id = public.current_pair_id() and pm.user_id = profiles.id
  )
);

drop policy if exists pairs_own_select on public.pairs;
create policy pairs_own_select on public.pairs for select to authenticated using (id = public.current_pair_id());

drop policy if exists pair_members_own_select on public.pair_members;
create policy pair_members_own_select on public.pair_members for select to authenticated using (pair_id = public.current_pair_id());

drop policy if exists tasks_pair_select on public.tasks;
create policy tasks_pair_select on public.tasks for select to authenticated using (pair_id = public.current_pair_id());

drop policy if exists attachments_pair_select on public.task_attachments;
create policy attachments_pair_select on public.task_attachments for select to authenticated using (pair_id = public.current_pair_id());

drop policy if exists attachments_pair_insert on public.task_attachments;
create policy attachments_pair_insert on public.task_attachments for insert to authenticated with check (
  pair_id = public.current_pair_id() and uploaded_by = auth.uid() and exists (
    select 1 from public.tasks t where t.id = task_id and t.pair_id = public.current_pair_id()
  )
);

drop policy if exists devices_own_select on public.device_subscriptions;
create policy devices_own_select on public.device_subscriptions for select to authenticated using (user_id = auth.uid());

drop policy if exists task_events_pair_select on public.task_events;
create policy task_events_pair_select on public.task_events for select to authenticated using (pair_id = public.current_pair_id());

-- Klient nemá priame INSERT/UPDATE/DELETE práva na tasks a notification_jobs.
revoke insert, update, delete on public.tasks from anon, authenticated;
revoke all on public.notification_jobs from anon, authenticated;
revoke all on public.client_mutations from anon, authenticated;
revoke insert, update, delete on public.task_events from anon, authenticated;
revoke insert, update, delete on public.device_subscriptions from anon, authenticated;

create or replace function public.next_occurrence(
  p_due_at timestamptz,
  p_rule text,
  p_timezone text,
  p_anchor_at timestamptz default null
)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v_tz text:=coalesce(nullif(p_timezone,''),'Europe/Bratislava');
  v_local timestamp:=p_due_at at time zone v_tz;
  v_anchor_local timestamp:=coalesce(p_anchor_at,p_due_at) at time zone v_tz;
  v_target_month timestamp;
  v_last_day integer;
  v_anchor_day integer:=extract(day from v_anchor_local)::integer;
begin
  if p_rule='daily' then return (v_local+interval '1 day') at time zone v_tz; end if;
  if p_rule='weekly' then return (v_local+interval '1 week') at time zone v_tz; end if;
  if p_rule='monthly' then
    v_target_month:=date_trunc('month',v_local)+interval '1 month';
    v_last_day:=extract(day from (date_trunc('month',v_target_month)+interval '1 month - 1 day'))::integer;
    return (
      make_date(extract(year from v_target_month)::integer,extract(month from v_target_month)::integer,least(v_anchor_day,v_last_day))
      + v_anchor_local::time
    ) at time zone v_tz;
  end if;
  return null;
end;
$$;

create or replace function public.cancel_task_notification_jobs(p_task_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notification_jobs
  set status = 'cancelled'
  where task_id = p_task_id and status in ('queued','processing') and kind in ('task_pre','task_due','task_repeat')
$$;

create or replace function public.enqueue_task_notification_jobs(p_task public.tasks)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due timestamptz := coalesce(p_task.snoozed_until, p_task.due_at);
  v_pre timestamptz;
begin
  perform public.cancel_task_notification_jobs(p_task.id);
  if p_task.status <> 'pending' or p_task.deleted_at is not null or p_task.acknowledged_at is not null then return; end if;

  if p_task.pre_reminder_minutes > 0 and p_task.snoozed_until is null then
    v_pre := p_task.due_at - make_interval(mins => p_task.pre_reminder_minutes);
    if v_pre > now() then
      insert into public.notification_jobs(task_id, recipient_id, kind, scheduled_at, dedupe_key)
      values (p_task.id, p_task.assigned_to, 'task_pre', v_pre, 'task-pre:' || p_task.id || ':v' || p_task.version || ':' || extract(epoch from v_pre)::bigint)
      on conflict (dedupe_key) do nothing;
    end if;
  end if;

  insert into public.notification_jobs(task_id, recipient_id, kind, scheduled_at, dedupe_key)
  values (p_task.id, p_task.assigned_to, 'task_due', greatest(v_due, now()), 'task-due:' || p_task.id || ':v' || p_task.version || ':' || extract(epoch from v_due)::bigint)
  on conflict (dedupe_key) do nothing;
end;
$$;

create or replace function public.create_next_recurring_task(p_source public.tasks)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next timestamptz;
  v_anchor timestamptz;
  v_id uuid := gen_random_uuid();
  v_task public.tasks;
  v_guard integer := 0;
begin
  if p_source.recurrence_rule = 'none' then return null; end if;
  select occurrence_at into v_anchor from public.tasks where id=p_source.series_id;
  v_anchor := coalesce(v_anchor,p_source.occurrence_at);
  v_next := public.next_occurrence(p_source.occurrence_at,p_source.recurrence_rule,p_source.timezone,v_anchor);
  if v_next is null then return null; end if;

  -- Po dlhšom výpadku nevytváraj desiatky historických výskytov ani
  -- okamžité push upozornenia na každý z nich. Zachovaj pôvodné správanie
  -- aplikácie a preskoč na najbližší budúci termín.
  while v_next <= now() and v_guard < 1000 loop
    v_next := public.next_occurrence(v_next,p_source.recurrence_rule,p_source.timezone,v_anchor);
    v_guard := v_guard + 1;
  end loop;
  if v_next is null or v_next <= now() then raise exception 'RECURRENCE_GUARD_EXCEEDED'; end if;

  insert into public.tasks(
    id,pair_id,created_by,assigned_to,title,notes,due_at,timezone,priority,pre_reminder_minutes,
    recurrence_rule,recurrence_mode,series_id,occurrence_at,notify_creator_on_complete,
    reminder_interval_seconds,max_reminders,status,last_changed_by
  ) values (
    v_id,p_source.pair_id,p_source.created_by,p_source.assigned_to,p_source.title,p_source.notes,v_next,p_source.timezone,
    p_source.priority,p_source.pre_reminder_minutes,p_source.recurrence_rule,p_source.recurrence_mode,p_source.series_id,v_next,
    p_source.notify_creator_on_complete,p_source.reminder_interval_seconds,p_source.max_reminders,'pending',p_source.last_changed_by
  )
  on conflict (series_id, occurrence_at) do nothing
  returning * into v_task;

  if v_task.id is not null then
    perform public.enqueue_task_notification_jobs(v_task);
    return v_task.id;
  end if;
  return null;
end;
$$;

create or replace function public.mutation_is_duplicate(p_mutation_id uuid, p_operation text, p_task_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_existing public.client_mutations;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_existing from public.client_mutations where mutation_id=p_mutation_id;
  if v_existing.mutation_id is not null then
    if v_existing.user_id<>auth.uid() or v_existing.operation<>p_operation or v_existing.task_id is distinct from p_task_id then
      raise exception 'MUTATION_ID_REUSE';
    end if;
    return true;
  end if;
  insert into public.client_mutations(mutation_id,user_id,operation,task_id)
  values(p_mutation_id,auth.uid(),p_operation,p_task_id);
  return false;
end;
$$;

create or replace function public.api_create_task(
  p_id uuid,
  p_mutation_id uuid,
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
set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid();
  v_pair uuid;
  v_task public.tasks;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select pair_id into v_pair from public.pair_members where user_id = v_user;
  if v_pair is null then raise exception 'PAIR_NOT_CONFIGURED'; end if;
  if not exists(select 1 from public.pair_members where pair_id = v_pair and user_id = p_assigned_to) then raise exception 'INVALID_ASSIGNEE'; end if;
  if not exists(select 1 from pg_timezone_names where name=coalesce(nullif(p_timezone,''),'Europe/Bratislava')) then raise exception 'INVALID_TIMEZONE'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'create',p_id) then
    select * into v_task from public.tasks where id=p_id and pair_id=v_pair;
    if v_task.id is null then raise exception 'MUTATION_RESULT_MISSING'; end if;
    return v_task;
  end if;

  insert into public.tasks(
    id,pair_id,created_by,assigned_to,title,notes,due_at,timezone,priority,pre_reminder_minutes,
    recurrence_rule,recurrence_mode,series_id,occurrence_at,notify_creator_on_complete,
    reminder_interval_seconds,max_reminders,last_changed_by
  ) values (
    p_id,v_pair,v_user,p_assigned_to,trim(p_title),nullif(trim(coalesce(p_notes,'')),''),p_due_at,coalesce(nullif(p_timezone,''),'Europe/Bratislava'),
    p_priority,p_pre_reminder_minutes,p_recurrence_rule,p_recurrence_mode,p_id,p_due_at,p_notify_creator_on_complete,
    p_reminder_interval_seconds,p_max_reminders,v_user
  ) returning * into v_task;

  insert into public.task_events(task_id,pair_id,actor_id,event_type) values(v_task.id,v_pair,v_user,'created');
  if p_assigned_to <> v_user then
    insert into public.notification_jobs(task_id,recipient_id,kind,scheduled_at,dedupe_key)
    values(v_task.id,p_assigned_to,'task_assigned',now(),'task-assigned:'||v_task.id)
    on conflict(dedupe_key) do nothing;
  end if;
  perform public.enqueue_task_notification_jobs(v_task);
  return v_task;
end;
$$;

create or replace function public.api_update_task(
  p_task_id uuid,
  p_mutation_id uuid,
  p_expected_version bigint,
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
set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid(); v_task public.tasks; v_old_assigned uuid;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if v_task.id is null or v_task.pair_id <> public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'update',p_task_id) then return v_task; end if;
  if v_task.deleted_at is not null then raise exception 'TASK_DELETED'; end if;
  if v_task.version <> p_expected_version then raise exception 'TASK_CONFLICT'; end if;
  if not exists(select 1 from public.pair_members where pair_id=v_task.pair_id and user_id=p_assigned_to) then raise exception 'INVALID_ASSIGNEE'; end if;
  if not exists(select 1 from pg_timezone_names where name=coalesce(nullif(p_timezone,''),'Europe/Bratislava')) then raise exception 'INVALID_TIMEZONE'; end if;
  v_old_assigned := v_task.assigned_to;

  update public.tasks set
    assigned_to=p_assigned_to,title=trim(p_title),notes=nullif(trim(coalesce(p_notes,'')),''),due_at=p_due_at,
    occurrence_at=case when series_id=id then p_due_at else occurrence_at end,
    timezone=coalesce(nullif(p_timezone,''),'Europe/Bratislava'),priority=p_priority,pre_reminder_minutes=p_pre_reminder_minutes,
    recurrence_rule=p_recurrence_rule,recurrence_mode=p_recurrence_mode,notify_creator_on_complete=p_notify_creator_on_complete,
    reminder_interval_seconds=p_reminder_interval_seconds,max_reminders=p_max_reminders,reminders_sent=0,
    snoozed_until=null,acknowledged_by=null,acknowledged_at=null,updated_at=now(),version=version+1,last_changed_by=v_user
  where id=p_task_id returning * into v_task;

  insert into public.task_events(task_id,pair_id,actor_id,event_type) values(v_task.id,v_task.pair_id,v_user,'updated');
  if p_assigned_to <> v_old_assigned then
    update public.notification_jobs set status='cancelled'
    where task_id=v_task.id and kind='task_assigned' and status in ('queued','processing');
    -- Keď si používateľ priradí úlohu sám sebe, neposielaj mu zavádzajúcu
    -- správu „Nová úloha od partnera“.
    if p_assigned_to <> v_user then
      insert into public.notification_jobs(task_id,recipient_id,kind,scheduled_at,dedupe_key)
      values(v_task.id,p_assigned_to,'task_assigned',now(),'task-reassigned:'||v_task.id||':'||v_task.version)
      on conflict(dedupe_key) do nothing;
    end if;
  end if;
  perform public.enqueue_task_notification_jobs(v_task);
  return v_task;
end;
$$;

create or replace function public.api_acknowledge_task(p_task_id uuid, p_mutation_id uuid)
returns public.tasks
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_task public.tasks;
begin
  select * into v_task from public.tasks where id=p_task_id for update;
  if v_task.id is null or v_task.pair_id<>public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if v_task.assigned_to<>v_user then raise exception 'ONLY_ASSIGNEE_CAN_ACKNOWLEDGE'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'acknowledge',p_task_id) then return v_task; end if;
  if v_task.status<>'pending' then return v_task; end if;
  update public.tasks set acknowledged_by=v_user,acknowledged_at=now(),updated_at=now(),version=version+1,last_changed_by=v_user where id=p_task_id returning * into v_task;
  perform public.cancel_task_notification_jobs(p_task_id);
  insert into public.task_events(task_id,pair_id,actor_id,event_type) values(v_task.id,v_task.pair_id,v_user,'acknowledged');
  return v_task;
end;
$$;

create or replace function public.api_complete_task(p_task_id uuid, p_mutation_id uuid)
returns public.tasks
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_task public.tasks;
begin
  select * into v_task from public.tasks where id=p_task_id for update;
  if v_task.id is null or v_task.pair_id<>public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if v_task.assigned_to<>v_user then raise exception 'ONLY_ASSIGNEE_CAN_COMPLETE'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'complete',p_task_id) then return v_task; end if;
  if v_task.status='completed' then return v_task; end if;
  if v_task.deleted_at is not null then raise exception 'TASK_DELETED'; end if;

  update public.tasks set status='completed',completed_by=v_user,completed_at=now(),acknowledged_by=v_user,acknowledged_at=coalesce(acknowledged_at,now()),updated_at=now(),version=version+1,last_changed_by=v_user where id=p_task_id returning * into v_task;
  perform public.cancel_task_notification_jobs(p_task_id);
  insert into public.task_events(task_id,pair_id,actor_id,event_type) values(v_task.id,v_task.pair_id,v_user,'completed');

  if v_task.notify_creator_on_complete and v_task.created_by<>v_task.assigned_to then
    insert into public.notification_jobs(task_id,recipient_id,kind,scheduled_at,dedupe_key)
    values(v_task.id,v_task.created_by,'task_completed',now(),'task-completed:'||v_task.id)
    on conflict(dedupe_key) do nothing;
  end if;
  if v_task.recurrence_rule<>'none' and v_task.recurrence_mode='after' then perform public.create_next_recurring_task(v_task); end if;
  return v_task;
end;
$$;

create or replace function public.api_snooze_task(p_task_id uuid, p_minutes integer, p_mutation_id uuid)
returns public.tasks
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_task public.tasks;
begin
  if p_minutes<1 or p_minutes>10080 then raise exception 'INVALID_SNOOZE'; end if;
  select * into v_task from public.tasks where id=p_task_id for update;
  if v_task.id is null or v_task.pair_id<>public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if v_task.assigned_to<>v_user then raise exception 'ONLY_ASSIGNEE_CAN_SNOOZE'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'snooze',p_task_id) then return v_task; end if;
  if v_task.status<>'pending' then return v_task; end if;
  update public.tasks set snoozed_until=now()+make_interval(mins=>p_minutes),acknowledged_by=null,acknowledged_at=null,reminders_sent=0,updated_at=now(),version=version+1,last_changed_by=v_user where id=p_task_id returning * into v_task;
  perform public.enqueue_task_notification_jobs(v_task);
  insert into public.task_events(task_id,pair_id,actor_id,event_type,payload) values(v_task.id,v_task.pair_id,v_user,'snoozed',jsonb_build_object('minutes',p_minutes));
  return v_task;
end;
$$;

create or replace function public.api_delete_task(p_task_id uuid, p_mutation_id uuid)
returns public.tasks
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_task public.tasks;
begin
  select * into v_task from public.tasks where id=p_task_id for update;
  if v_task.id is null or v_task.pair_id<>public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if v_user not in (v_task.created_by,v_task.assigned_to) then raise exception 'NOT_ALLOWED'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'delete',p_task_id) then return v_task; end if;
  if v_task.deleted_at is not null then return v_task; end if;
  update public.tasks set status='cancelled',deleted_at=now(),updated_at=now(),version=version+1,last_changed_by=v_user where id=p_task_id returning * into v_task;
  perform public.cancel_task_notification_jobs(p_task_id);
  update public.notification_jobs set status='cancelled'
  where task_id=p_task_id and kind='task_assigned' and status in ('queued','processing');
  insert into public.task_events(task_id,pair_id,actor_id,event_type) values(v_task.id,v_task.pair_id,v_user,'deleted');
  return v_task;
end;
$$;

create or replace function public.api_register_device(p_subscription_id text,p_platform text,p_device_install_id uuid,p_device_name text)
returns public.device_subscriptions
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_row public.device_subscriptions;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_subscription_id is null or char_length(trim(p_subscription_id))<10 or char_length(p_subscription_id)>200 then raise exception 'INVALID_SUBSCRIPTION_ID'; end if;
  if p_platform not in ('ios','android','web') then raise exception 'INVALID_PLATFORM'; end if;
  if p_device_install_id is null then raise exception 'INVALID_DEVICE_INSTALL_ID'; end if;
  if p_device_name is not null and char_length(p_device_name)>160 then raise exception 'INVALID_DEVICE_NAME'; end if;
  if exists(select 1 from public.device_subscriptions where subscription_id=p_subscription_id and user_id<>v_user and active) then
    raise exception 'SUBSCRIPTION_ALREADY_OWNED';
  end if;
  insert into public.device_subscriptions(subscription_id,user_id,platform,device_install_id,device_name,active,last_seen_at)
  values(p_subscription_id,v_user,p_platform,p_device_install_id,p_device_name,true,now())
  on conflict(subscription_id) do update set user_id=excluded.user_id,platform=excluded.platform,device_install_id=excluded.device_install_id,device_name=excluded.device_name,active=true,last_seen_at=now()
  returning * into v_row;
  update public.device_subscriptions set active=false where user_id=v_user and device_install_id=p_device_install_id and subscription_id<>p_subscription_id;
  update public.notification_jobs
  set status='queued',scheduled_at=now(),attempt_count=0,locked_at=null,last_error=null
  where recipient_id=v_user
    and status='failed'
    and last_error like '%NO_ACTIVE_SUBSCRIPTIONS%'
    and (
      (kind in ('task_assigned','task_completed') and created_at>now()-interval '1 day')
      or (kind='test' and created_at>now()-interval '15 minutes')
    );
  return v_row;
end;
$$;

create or replace function public.api_unregister_device(p_subscription_id text)
returns void
language sql
security definer
set search_path = public, auth
as $$ update public.device_subscriptions set active=false,last_seen_at=now() where subscription_id=p_subscription_id and user_id=auth.uid() $$;

create or replace function public.api_send_test_notification()
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_id uuid:=gen_random_uuid(); v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if exists(
    select 1 from public.notification_jobs
    where recipient_id=v_user and kind='test' and created_at>now()-interval '30 seconds'
      and status in ('queued','processing','sent')
  ) then raise exception 'TEST_NOTIFICATION_RATE_LIMIT'; end if;
  insert into public.notification_jobs(id,recipient_id,kind,scheduled_at,dedupe_key) values(v_id,v_user,'test',now(),'test:'||v_user||':'||v_id);
  return v_id;
end;
$$;

create or replace function public.api_generate_recurring_occurrences()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_task public.tasks; v_count integer:=0; v_new uuid;
begin
  for v_task in
    select latest.* from (
      select distinct on (series_id) *
      from public.tasks
      where recurrence_rule<>'none' and recurrence_mode='each' and deleted_at is null
      order by series_id,occurrence_at desc
    ) latest
    where latest.occurrence_at<=now()
  loop
    v_new:=public.create_next_recurring_task(v_task);
    if v_new is not null then v_count:=v_count+1; end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.claim_notification_jobs(p_limit integer default 25)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notification_jobs
  set status='queued',locked_at=null,last_error=coalesce(last_error,'')||' [stale lock recovered]'
  where status='processing' and locked_at<now()-interval '10 minutes';

  return query
  with selected as (
    select id from public.notification_jobs
    where status='queued' and scheduled_at<=now()
    order by scheduled_at
    for update skip locked
    limit greatest(1,least(p_limit,100))
  )
  update public.notification_jobs j set status='processing',locked_at=now(),attempt_count=attempt_count+1
  from selected s where j.id=s.id returning j.*;
end;
$$;

create or replace function public.mark_notification_sent(p_job_id uuid,p_message_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.notification_jobs;
  v_task public.tasks;
  v_job_version bigint;
  v_effective_due timestamptz;
begin
  update public.notification_jobs
  set status='sent',sent_at=now(),onesignal_message_id=p_message_id,last_error=null,locked_at=null
  where id=p_job_id and status='processing'
  returning * into v_job;
  -- Starý alebo duplicitný worker už nesmie druhýkrát zvýšiť reminders_sent.
  if v_job.id is null then return; end if;
  if v_job.task_id is null or v_job.kind not in ('task_due','task_repeat') then return; end if;

  select * into v_task from public.tasks where id=v_job.task_id for update;
  if v_task.id is null then return; end if;

  -- Ak používateľ úlohu odložil alebo upravil počas odosielania do OneSignal,
  -- starý job síce už mohol fyzicky odísť, ale nesmie poškodiť nový cyklus,
  -- zvýšiť jeho počítadlo ani naplánovať predčasný repeat.
  begin
    v_job_version := substring(v_job.dedupe_key from ':v([0-9]+)')::bigint;
  exception when others then
    v_job_version := null;
  end;
  if v_job_version is not null and v_job_version <> v_task.version then return; end if;
  v_effective_due := coalesce(v_task.snoozed_until,v_task.due_at);
  if v_task.status<>'pending' or v_task.deleted_at is not null or v_task.acknowledged_at is not null then return; end if;
  if v_effective_due > now()+interval '5 seconds' then return; end if;

  update public.tasks set reminders_sent=reminders_sent+1 where id=v_task.id returning * into v_task;
  if v_task.reminders_sent<v_task.max_reminders then
    insert into public.notification_jobs(task_id,recipient_id,kind,scheduled_at,dedupe_key)
    values(v_task.id,v_task.assigned_to,'task_repeat',now()+make_interval(secs=>v_task.reminder_interval_seconds),'task-repeat:'||v_task.id||':v'||v_task.version||':'||(v_task.reminders_sent+1))
    on conflict(dedupe_key) do nothing;
  end if;
end;
$$;

create or replace function public.mark_notification_failed(p_job_id uuid,p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
  v_delay interval;
begin
  select attempt_count into v_attempts from public.notification_jobs where id=p_job_id and status='processing';
  if v_attempts is null then return; end if;
  if p_error like '%NO_ACTIVE_SUBSCRIPTIONS%' then
    v_max_attempts:=96;
    v_delay:=interval '15 minutes';
  else
    v_max_attempts:=5;
    v_delay:=interval '2 minutes';
  end if;
  update public.notification_jobs
  set status=case when coalesce(v_attempts,0)>=v_max_attempts then 'failed' else 'queued' end,
      scheduled_at=case when coalesce(v_attempts,0)>=v_max_attempts then scheduled_at else now()+v_delay end,
      locked_at=null,last_error=left(p_error,1000)
  where id=p_job_id and status='processing';
end;
$$;

-- Interné SECURITY DEFINER funkcie nesmú byť priamo volateľné klientom.
revoke all on function public.next_occurrence(timestamptz,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.cancel_task_notification_jobs(uuid) from public,anon,authenticated;
revoke all on function public.enqueue_task_notification_jobs(public.tasks) from public,anon,authenticated;
revoke all on function public.create_next_recurring_task(public.tasks) from public,anon,authenticated;
revoke all on function public.mutation_is_duplicate(uuid,text,uuid) from public,anon,authenticated;

-- Oprávnenia RPC pre aplikáciu.
revoke all on function public.api_create_task(uuid,uuid,uuid,text,text,timestamptz,text,integer,integer,text,text,boolean,integer,integer) from public;
revoke all on function public.api_update_task(uuid,uuid,bigint,uuid,text,text,timestamptz,text,integer,integer,text,text,boolean,integer,integer) from public;
revoke all on function public.api_acknowledge_task(uuid,uuid) from public;
revoke all on function public.api_complete_task(uuid,uuid) from public;
revoke all on function public.api_snooze_task(uuid,integer,uuid) from public;
revoke all on function public.api_delete_task(uuid,uuid) from public;
revoke all on function public.api_register_device(text,text,uuid,text) from public;
revoke all on function public.api_unregister_device(text) from public;
revoke all on function public.api_send_test_notification() from public;

grant execute on function public.api_create_task(uuid,uuid,uuid,text,text,timestamptz,text,integer,integer,text,text,boolean,integer,integer) to authenticated;
grant execute on function public.api_update_task(uuid,uuid,bigint,uuid,text,text,timestamptz,text,integer,integer,text,text,boolean,integer,integer) to authenticated;
grant execute on function public.api_acknowledge_task(uuid,uuid) to authenticated;
grant execute on function public.api_complete_task(uuid,uuid) to authenticated;
grant execute on function public.api_snooze_task(uuid,integer,uuid) to authenticated;
grant execute on function public.api_delete_task(uuid,uuid) to authenticated;
grant execute on function public.api_register_device(text,text,uuid,text) to authenticated;
grant execute on function public.api_unregister_device(text) to authenticated;
grant execute on function public.api_send_test_notification() to authenticated;

revoke all on function public.claim_notification_jobs(integer) from public,anon,authenticated;
revoke all on function public.mark_notification_sent(uuid,text) from public,anon,authenticated;
revoke all on function public.mark_notification_failed(uuid,text) from public,anon,authenticated;
revoke all on function public.api_generate_recurring_occurrences() from public,anon,authenticated;
grant execute on function public.claim_notification_jobs(integer) to service_role;
grant execute on function public.mark_notification_sent(uuid,text) to service_role;
grant execute on function public.mark_notification_failed(uuid,text) to service_role;
grant execute on function public.api_generate_recurring_occurrences() to service_role;

-- Storage bucket pre prílohy.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('task-attachments','task-attachments',false,10485760,null)
on conflict(id) do update set public=false,file_size_limit=10485760;

drop policy if exists task_attachment_objects_select on storage.objects;
create policy task_attachment_objects_select on storage.objects for select to authenticated using (
  bucket_id='task-attachments' and (storage.foldername(name))[1]::uuid = public.current_pair_id()
  and exists (select 1 from public.tasks t where t.id=(storage.foldername(name))[2]::uuid and t.pair_id=public.current_pair_id())
);
drop policy if exists task_attachment_objects_insert on storage.objects;
create policy task_attachment_objects_insert on storage.objects for insert to authenticated with check (
  bucket_id='task-attachments' and (storage.foldername(name))[1]::uuid = public.current_pair_id()
  and exists (select 1 from public.tasks t where t.id=(storage.foldername(name))[2]::uuid and t.pair_id=public.current_pair_id())
);
drop policy if exists task_attachment_objects_delete on storage.objects;
create policy task_attachment_objects_delete on storage.objects for delete to authenticated using (
  bucket_id='task-attachments' and owner_id=auth.uid()::text
);

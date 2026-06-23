-- Nezabudni v19 – Bezpečnostná oprava: trojhodnotová logika pri kontrole páru.
-- Spusti po 001..007. Aditívne a bezpečné spustiť opakovane (create or replace).
--
-- PROBLÉM (CRITICAL): kontrola `v_task.pair_id <> public.current_pair_id()`
-- zlyhá, keď current_pair_id() vráti NULL (overený používateľ BEZ členstva v páre).
-- `pair_id <> NULL` sa vyhodnotí ako NULL → v PL/pgSQL IF sa NULL berie ako FALSE →
-- výnimka TASK_NOT_FOUND sa NEVYVOLÁ a beh pokračuje. Používateľ mimo páru tak
-- mohol (pri znalosti task_id) prejsť cez prvú hranicu autorizácie.
--
-- OPRAVA: `is distinct from` je NULL-bezpečné. Keď current_pair_id() je NULL a
-- pair_id je reálne UUID, `pair_id is distinct from NULL` = TRUE → TASK_NOT_FOUND.
-- Pravidlo sa tým iba SPRÍSNI (RLS sa neoslabuje). Rekreujeme NAJNOVŠIE platné
-- definície všetkých 7 zasiahnutých funkcií, vrátane terminálnych/null guardov.

-- 1) api_acknowledge_task (pôvodne 001)
create or replace function public.api_acknowledge_task(p_task_id uuid, p_mutation_id uuid)
returns public.tasks
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_task public.tasks;
begin
  select * into v_task from public.tasks where id=p_task_id for update;
  if v_task.id is null or v_task.pair_id is distinct from public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if v_task.assigned_to<>v_user then raise exception 'ONLY_ASSIGNEE_CAN_ACKNOWLEDGE'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'acknowledge',p_task_id) then return v_task; end if;
  if v_task.status<>'pending' then return v_task; end if;
  update public.tasks set acknowledged_by=v_user,acknowledged_at=now(),updated_at=now(),version=version+1,last_changed_by=v_user where id=p_task_id returning * into v_task;
  perform public.cancel_task_notification_jobs(p_task_id);
  insert into public.task_events(task_id,pair_id,actor_id,event_type) values(v_task.id,v_task.pair_id,v_user,'acknowledged');
  return v_task;
end;
$$;

-- 2) api_complete_task (pôvodne 001)
create or replace function public.api_complete_task(p_task_id uuid, p_mutation_id uuid)
returns public.tasks
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_task public.tasks;
begin
  select * into v_task from public.tasks where id=p_task_id for update;
  if v_task.id is null or v_task.pair_id is distinct from public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
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

-- 3) api_delete_task (pôvodne 001)
create or replace function public.api_delete_task(p_task_id uuid, p_mutation_id uuid)
returns public.tasks
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_task public.tasks;
begin
  select * into v_task from public.tasks where id=p_task_id for update;
  if v_task.id is null or v_task.pair_id is distinct from public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
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

-- 4) api_snooze_task (najnovšia: 005, 4-arg, absolútny čas)
create or replace function public.api_snooze_task(
  p_task_id uuid,
  p_minutes integer,
  p_mutation_id uuid,
  p_snoozed_until timestamptz default null
)
returns public.tasks
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_task public.tasks; v_until timestamptz;
begin
  if p_minutes is not null and (p_minutes<1 or p_minutes>10080) then raise exception 'INVALID_SNOOZE'; end if;
  v_until := coalesce(p_snoozed_until, now() + make_interval(mins => p_minutes));
  if v_until is null then raise exception 'INVALID_SNOOZE'; end if;
  if v_until <= now() then v_until := now() + interval '1 minute'; end if;
  if v_until > now() + interval '7 days' then v_until := now() + interval '7 days'; end if;
  select * into v_task from public.tasks where id=p_task_id for update;
  if v_task.id is null or v_task.pair_id is distinct from public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if v_task.assigned_to<>v_user then raise exception 'ONLY_ASSIGNEE_CAN_SNOOZE'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'snooze',p_task_id) then return v_task; end if;
  if v_task.status<>'pending' then return v_task; end if;
  update public.tasks set snoozed_until=v_until,acknowledged_by=null,acknowledged_at=null,reminders_sent=0,updated_at=now(),version=version+1,last_changed_by=v_user where id=p_task_id returning * into v_task;
  perform public.enqueue_task_notification_jobs(v_task);
  insert into public.task_events(task_id,pair_id,actor_id,event_type,payload)
  values(v_task.id,v_task.pair_id,v_user,'snoozed',jsonb_build_object('minutes',p_minutes,'until',v_until));
  return v_task;
end;
$$;

-- 5) api_update_task (najnovšia: 006, terminálny guard)
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
  if v_task.id is null or v_task.pair_id is distinct from public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'update',p_task_id) then return v_task; end if;
  if v_task.deleted_at is not null then raise exception 'TASK_DELETED'; end if;
  if v_task.status <> 'pending' then raise exception 'TASK_NOT_EDITABLE'; end if;
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

-- 6) api_reject_task (pôvodne 007)
create or replace function public.api_reject_task(p_task_id uuid, p_reason text, p_mutation_id uuid)
returns public.tasks
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_task public.tasks; v_reason text:=trim(coalesce(p_reason,''));
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if char_length(v_reason) < 1 then raise exception 'REJECTION_REASON_REQUIRED'; end if;
  if char_length(v_reason) > 500 then raise exception 'REJECTION_REASON_TOO_LONG'; end if;
  select * into v_task from public.tasks where id=p_task_id for update;
  if v_task.id is null or v_task.pair_id is distinct from public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if v_task.assigned_to<>v_user then raise exception 'ONLY_ASSIGNEE_CAN_REJECT'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'reject',p_task_id) then return v_task; end if;
  if v_task.status<>'pending' then return v_task; end if;
  update public.tasks set status='rejected',rejection_reason=v_reason,rejected_by=v_user,rejected_at=now(),
    snoozed_until=null,acknowledged_by=null,acknowledged_at=null,updated_at=now(),version=version+1,last_changed_by=v_user
  where id=p_task_id returning * into v_task;
  perform public.cancel_task_notification_jobs(p_task_id);
  insert into public.task_events(task_id,pair_id,actor_id,event_type,payload)
  values(v_task.id,v_task.pair_id,v_user,'rejected',jsonb_build_object('reason',v_reason));
  return v_task;
end;
$$;

-- 7) api_hide_task_for_self (pôvodne 007)
create or replace function public.api_hide_task_for_self(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_task public.tasks;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_task from public.tasks where id=p_task_id;
  if v_task.id is null or v_task.pair_id is distinct from public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if v_user not in (v_task.assigned_to, v_task.created_by) then raise exception 'NOT_ALLOWED'; end if;
  if v_task.status = 'pending' then raise exception 'TASK_STILL_ACTIVE'; end if;
  insert into public.task_hidden(task_id,user_id) values(p_task_id,v_user) on conflict do nothing;
end;
$$;

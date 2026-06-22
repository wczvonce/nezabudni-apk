-- Nezabudni v19.0.2.2 – inkrementálne opravy po hĺbkovom audite
-- Spusti iba ak už bola v Supabase nasadená 001_schema.sql.
-- Nová čistá inštalácia dostane rovnaké opravy priamo z 001_schema.sql.

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

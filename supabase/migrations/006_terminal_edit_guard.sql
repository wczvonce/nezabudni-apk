-- Nezabudni v19 – Issue 3: terminálne úlohy sa nesmú editovať (backend hranica).
-- Spusti až po 001/004. Bezpečné spustiť opakovane.
--
-- Doteraz api_update_task blokoval iba zmazané úlohy. Editovanie completed/cancelled
-- úlohy by ju nekonzistentne „upravilo" (reset stavu pripomienok). Pridávame tvrdú
-- backend kontrolu: editovať možno iba pending úlohu. UI síce skrýva edit pre
-- terminálne úlohy, ale pravidlo sa nesmie dať obísť úpravou klienta.

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
  -- Issue 3: terminálnu úlohu nemožno editovať na aktívnu pripomienku.
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

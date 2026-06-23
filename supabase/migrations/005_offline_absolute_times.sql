-- Nezabudni v19 – Issue 6: offline snooze musí použiť ABSOLÚTNY čas.
-- Spusti iba ak už bola nasadená 001_schema.sql. Bezpečné spustiť opakovane.
--
-- Problém: klient pri offline snooze zaradil do outboxu relatívne minúty a
-- api_snooze_task počítal snoozed_until = now() + minúty zo SERVEROVÉHO času pri
-- neskorej synchronizácii → pripomienka sa posunula (drift). Klient teraz posiela
-- absolútny čas vypočítaný v okamihu akcie; server ho uprednostní.

drop function if exists public.api_snooze_task(uuid, integer, uuid);

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
  -- Absolútny čas (od klienta v čase akcie) má prednosť; fallback je relatívny.
  v_until := coalesce(p_snoozed_until, now() + make_interval(mins => p_minutes));
  if v_until is null then raise exception 'INVALID_SNOOZE'; end if;
  if v_until <= now() then v_until := now() + interval '1 minute'; end if;          -- nikdy do minulosti
  if v_until > now() + interval '7 days' then v_until := now() + interval '7 days'; end if; -- horný strop
  select * into v_task from public.tasks where id=p_task_id for update;
  if v_task.id is null or v_task.pair_id<>public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
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

revoke all on function public.api_snooze_task(uuid,integer,uuid,timestamptz) from public, anon;
grant execute on function public.api_snooze_task(uuid,integer,uuid,timestamptz) to authenticated;

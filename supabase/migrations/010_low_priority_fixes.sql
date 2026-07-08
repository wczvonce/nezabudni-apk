-- 010: opravy nízkej priority z hĺbkového bug huntu 2026-07-08
--  1) api_delete_task: zmazanie splnenej/odmietnutej úlohy NESMIE prepísať jej
--     terminálny stav na 'cancelled' — história partnera by stratila info,
--     že úloha bola splnená. 'cancelled' patrí len rušeným pending úlohám.
--  2) claim_notification_jobs: stale-recovery strop pokusov musí rešpektovať
--     NO_ACTIVE_SUBSCRIPTIONS vetvu (96 × 15 min), inak pád workera počas
--     čakania na registráciu zariadenia predčasne pochová task_due joby.
--  3) api_unregister_install: núdzové odregistrovanie VŠETKÝCH subscriptions
--     daného zariadenia pri odhlásení — keď OneSignal SDK inicializácia
--     zlyhala, klient nepozná subscription_id, ale device_install_id
--     (localStorage) má vždy. Bez toho by odhlásený telefón dostával pushe.

-- ── 1) api_delete_task: zachovaj terminálny stav ─────────────────────────────
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
  update public.tasks
  set status=case when status='pending' then 'cancelled' else status end,
      deleted_at=now(),updated_at=now(),version=version+1,last_changed_by=v_user
  where id=p_task_id returning * into v_task;
  perform public.cancel_task_notification_jobs(p_task_id);
  update public.notification_jobs set status='cancelled'
  where task_id=p_task_id and kind='task_assigned' and status in ('queued','processing');
  insert into public.task_events(task_id,pair_id,actor_id,event_type) values(v_task.id,v_task.pair_id,v_user,'deleted');
  return v_task;
end;
$$;

-- ── 2) claim_notification_jobs: recovery strop podľa typu chyby ──────────────
create or replace function public.claim_notification_jobs(p_limit integer default 25)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Recovery rešpektuje strop pokusov; NO_ACTIVE_SUBSCRIPTIONS vetva má
  -- rovnaký limit ako mark_notification_failed (96 pokusov ~ 24 h), inak by
  -- pád workera počas čakania na registráciu zariadenia job predčasne zabil.
  update public.notification_jobs
  set status=case
        when attempt_count >= (case when coalesce(last_error,'') like '%NO_ACTIVE_SUBSCRIPTIONS%' then 96 else 5 end)
          then 'failed' else 'queued' end,
      locked_at=null,
      last_error=left(coalesce(last_error,'')||' [stale lock recovered]',1000)
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

-- ── 3) api_unregister_install: núdzový logout fallback ───────────────────────
create or replace function public.api_unregister_install(p_device_install_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_user uuid:=auth.uid(); v_count integer;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_device_install_id is null then raise exception 'INVALID_DEVICE_INSTALL_ID'; end if;
  update public.device_subscriptions
  set active=false, last_seen_at=now()
  where user_id=v_user and device_install_id=p_device_install_id and active;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.api_unregister_install(uuid) from public;
grant execute on function public.api_unregister_install(uuid) to authenticated;

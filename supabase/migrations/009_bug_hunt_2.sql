-- Nezabudni v19 – Bug-hunt kolo 2 (2026-07): opravy potvrdených nálezov.
-- Spusti po 001..008. Bezpečné spustiť opakovane (create or replace / if not exists).
--
-- Opravy v tejto migrácii:
--  1) api_complete_task: odmietnutú (rejected) úlohu už NEMOŽNO dokončiť –
--     oneskorená offline mutácia "complete" prepisovala odmietnutie, posielala
--     autorovi push a pri recurrence_mode='after' spawnovala novú occurrence.
--  2) api_complete_task: zlyhanie naplánovania ďalšieho výskytu (napr.
--     RECURRENCE_GUARD_EXCEEDED pri >1000 zameškaných periódach) už nezablokuje
--     samotné dokončenie úlohy.
--  3) mark_notification_sent: konzistentné poradie zámkov (tasks -> notification_jobs).
--     Pôvodné poradie (job -> task) sa križovalo s API funkciami (task -> job)
--     a mohlo skončiť deadlockom 40P01; ak bol obeťou worker po fyzickom odoslaní
--     pushu, job ostal 'processing', po stale-recovery sa poslal DRUHÝKRÁT.
--  4) api_generate_recurring_occurrences: per-series izolácia chýb. Jedna
--     "otrávená" séria (guard exceeded) zhadzovala celý beh každú minútu a
--     generovanie sa potichu zastavilo pre VŠETKY série.
--  5) next_occurrence: daily/weekly odvodzujú čas z KOTVY série (ako monthly).
--     Predtým sa denná úloha o 02:30 po jarnej zmene času natrvalo posunula
--     na 03:30 (nasledujúci výskyt sa počítal z posunutého wall-clock času).
--  6) mutation_is_duplicate: race-safe idempotencia cez INSERT ... ON CONFLICT
--     (check-then-insert dával druhému súbežnému volaniu surovú 23505 chybu).
--  7) api_update_task: kolízia occurrence_at koreňa série s už vygenerovaným
--     výskytom vracia doménovú chybu TASK_CONFLICT namiesto surovej 23505.
--  8) claim_notification_jobs: stale-recovery rešpektuje limit pokusov –
--     worker opakovane umierajúci PO odoslaní pushu už nedoručuje ten istý
--     push každých ~10 minút donekonečna.
--  9) requeue_unfinished_jobs: joby vrátené do fronty kvôli deadlinu workera
--     nespaľujú attempt_count (claim ho inkrementoval bez reálneho pokusu).
-- 10) api_send_test_notification: rate-limit bez TOCTOU (advisory lock).
-- 11) indexy na horúce cesty notification_jobs (cancel per task pod zámkom,
--     stale-recovery scan každú minútu, dotazy per recipient).

-- ── 5) next_occurrence: DST-stabilný čas z kotvy série ──────────────────────
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
  -- Wall-clock čas sa vždy odvodzuje z kotvy série. Ak by sa odvodzoval z
  -- predchádzajúceho výskytu, jarný DST skok (neexistujúca 02:30) by posunul
  -- všetky nasledujúce výskyty natrvalo o hodinu.
  if p_rule='daily' then return ((v_local+interval '1 day')::date + v_anchor_local::time) at time zone v_tz; end if;
  if p_rule='weekly' then return ((v_local+interval '1 week')::date + v_anchor_local::time) at time zone v_tz; end if;
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

-- ── 6) mutation_is_duplicate: race-safe INSERT ... ON CONFLICT ───────────────
create or replace function public.mutation_is_duplicate(p_mutation_id uuid, p_operation text, p_task_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_existing public.client_mutations;
  v_inserted uuid;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  insert into public.client_mutations(mutation_id,user_id,operation,task_id)
  values(p_mutation_id,auth.uid(),p_operation,p_task_id)
  on conflict (mutation_id) do nothing
  returning mutation_id into v_inserted;
  if v_inserted is not null then return false; end if;

  select * into v_existing from public.client_mutations where mutation_id=p_mutation_id;
  if v_existing.user_id<>auth.uid() or v_existing.operation<>p_operation or v_existing.task_id is distinct from p_task_id then
    raise exception 'MUTATION_ID_REUSE';
  end if;
  return true;
end;
$$;

-- ── 1)+2) api_complete_task: terminálny guard + izolovaný spawn opakovania ──
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
  -- Odmietnutú (alebo inak terminálnu) úlohu nemôže oneskorená mutácia dokončiť.
  if v_task.status<>'pending' then raise exception 'TASK_NOT_EDITABLE'; end if;

  update public.tasks set status='completed',completed_by=v_user,completed_at=now(),acknowledged_by=v_user,acknowledged_at=coalesce(acknowledged_at,now()),updated_at=now(),version=version+1,last_changed_by=v_user where id=p_task_id returning * into v_task;
  perform public.cancel_task_notification_jobs(p_task_id);
  insert into public.task_events(task_id,pair_id,actor_id,event_type) values(v_task.id,v_task.pair_id,v_user,'completed');

  if v_task.notify_creator_on_complete and v_task.created_by<>v_task.assigned_to then
    insert into public.notification_jobs(task_id,recipient_id,kind,scheduled_at,dedupe_key)
    values(v_task.id,v_task.created_by,'task_completed',now(),'task-completed:'||v_task.id)
    on conflict(dedupe_key) do nothing;
  end if;
  if v_task.recurrence_rule<>'none' and v_task.recurrence_mode='after' then
    -- Zlyhanie plánovania ďalšieho výskytu nesmie vrátiť späť samotné dokončenie.
    begin
      perform public.create_next_recurring_task(v_task);
    exception when others then
      raise warning 'Nezabudni: naplanovanie dalsieho vyskytu zlyhalo (task %): %', v_task.id, sqlerrm;
    end;
  end if;
  return v_task;
end;
$$;

-- ── 7) api_update_task: kolízia occurrence_at -> TASK_CONFLICT ───────────────
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

  begin
    update public.tasks set
      assigned_to=p_assigned_to,title=trim(p_title),notes=nullif(trim(coalesce(p_notes,'')),''),due_at=p_due_at,
      occurrence_at=case when series_id=id then p_due_at else occurrence_at end,
      timezone=coalesce(nullif(p_timezone,''),'Europe/Bratislava'),priority=p_priority,pre_reminder_minutes=p_pre_reminder_minutes,
      recurrence_rule=p_recurrence_rule,recurrence_mode=p_recurrence_mode,notify_creator_on_complete=p_notify_creator_on_complete,
      reminder_interval_seconds=p_reminder_interval_seconds,max_reminders=p_max_reminders,reminders_sent=0,
      snoozed_until=null,acknowledged_by=null,acknowledged_at=null,updated_at=now(),version=version+1,last_changed_by=v_user
    where id=p_task_id returning * into v_task;
  exception when unique_violation then
    -- Nový due_at koreňa série koliduje s už vygenerovaným výskytom
    -- (unique(series_id, occurrence_at)) – doménová chyba namiesto surovej 23505.
    raise exception 'TASK_CONFLICT';
  end;

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

-- ── 3) mark_notification_sent: poradie zámkov tasks -> notification_jobs ─────
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
  select * into v_job from public.notification_jobs where id=p_job_id;
  if v_job.id is null then return; end if;

  -- Zamkni úlohu PRED zápisom do jobu. API funkcie držia zámok v poradí
  -- tasks -> notification_jobs (for update + cancel_task_notification_jobs);
  -- opačné poradie tu spôsobovalo deadlock a po jeho rollbacku dvojité pushe.
  if v_job.task_id is not null and v_job.kind in ('task_due','task_repeat') then
    select * into v_task from public.tasks where id=v_job.task_id for update;
  end if;

  update public.notification_jobs
  set status='sent',sent_at=now(),onesignal_message_id=p_message_id,last_error=null,locked_at=null
  where id=p_job_id and status='processing'
  returning * into v_job;
  -- Starý alebo duplicitný worker už nesmie druhýkrát zvýšiť reminders_sent.
  if v_job.id is null then return; end if;
  if v_job.task_id is null or v_job.kind not in ('task_due','task_repeat') then return; end if;
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

-- ── 4) api_generate_recurring_occurrences: per-series izolácia chýb ──────────
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
    -- Jedna zaseknutá séria (napr. RECURRENCE_GUARD_EXCEEDED) nesmie zastaviť
    -- generovanie pre všetky ostatné série.
    begin
      v_new:=public.create_next_recurring_task(v_task);
      if v_new is not null then v_count:=v_count+1; end if;
    exception when others then
      raise warning 'Nezabudni: generovanie opakovania zlyhalo (series %, task %): %', v_task.series_id, v_task.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;

-- ── 8) claim_notification_jobs: stale-recovery s limitom pokusov ─────────────
create or replace function public.claim_notification_jobs(p_limit integer default 25)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Recovery rešpektuje strop pokusov: job, ktorého worker opakovane umiera
  -- po odoslaní (bez mark_notification_sent), sa nesmie redoručovať donekonečna.
  update public.notification_jobs
  set status=case when attempt_count>=5 then 'failed' else 'queued' end,
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

-- ── 9) requeue_unfinished_jobs: vrátenie do fronty bez spálenia pokusu ───────
create or replace function public.requeue_unfinished_jobs(p_job_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.notification_jobs
  set status='queued', locked_at=null, attempt_count=greatest(attempt_count-1,0)
  where id=any(p_job_ids) and status='processing'
$$;
revoke all on function public.requeue_unfinished_jobs(uuid[]) from public,anon,authenticated;
grant execute on function public.requeue_unfinished_jobs(uuid[]) to service_role;

-- ── 10) api_send_test_notification: rate-limit bez TOCTOU ────────────────────
create or replace function public.api_send_test_notification()
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_id uuid:=gen_random_uuid(); v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  -- Serializuj súbežné volania toho istého používateľa (check-then-insert race).
  perform pg_advisory_xact_lock(hashtextextended('nezabudni-test-notification:'||v_user::text, 0));
  if exists(
    select 1 from public.notification_jobs
    where recipient_id=v_user and kind='test' and created_at>now()-interval '30 seconds'
      and status in ('queued','processing','sent')
  ) then raise exception 'TEST_NOTIFICATION_RATE_LIMIT'; end if;
  insert into public.notification_jobs(id,recipient_id,kind,scheduled_at,dedupe_key) values(v_id,v_user,'test',now(),'test:'||v_user||':'||v_id);
  return v_id;
end;
$$;

-- ── 11) indexy na horúce cesty notification_jobs ─────────────────────────────
-- cancel_task_notification_jobs beží v KAŽDOM task RPC pod zámkom riadku úlohy.
create index if not exists notification_jobs_task_active_idx
  on public.notification_jobs(task_id) where status in ('queued','processing');
-- Stale-recovery scan beží pri každom claime (každú minútu).
create index if not exists notification_jobs_processing_idx
  on public.notification_jobs(locked_at) where status='processing';
-- Rate-limit testu a requeue po registrácii zariadenia filtrujú per recipient.
create index if not exists notification_jobs_recipient_idx
  on public.notification_jobs(recipient_id, kind, created_at);

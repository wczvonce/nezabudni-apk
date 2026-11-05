-- Nezabudni v19 – 018: odpoveď na úlohu = posunutie ďalej s genézou (verzia 1.0.19).
-- Spusti po 001..017. Bezpečné spustiť opakovane (if not exists / create or replace).
--
-- Príjemca aktívnej úlohy, ktorú nevie dokončiť, na ňu „odpovie": napíše, čo
-- treba urobiť ďalej, a vyberie iného člena skupiny. V jednej transakcii:
--  1) pôvodná úloha sa zavrie ako 'handed_off' (Posunuté → komu, kedy),
--  2) vznikne nová úloha pre vybraného člena, prepojená cez parent_task_id
--     (z ktorej úlohy vznikla) a thread_id (prvá úloha reťaze),
--  3) nový príjemca dostane push 'task_assigned', pôvodnej úlohe sa zrušia
--     pripomienky. Opakovaná úloha pokračuje ako po splnení.
-- Genézu skladá klient z úloh s rovnakým thread_id; poznámky sa nekopírujú.
begin;

-- ── 1) nový koncový stav a prepojenie reťaze ─────────────────────────────────
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('pending','completed','cancelled','rejected','handed_off'));
alter table public.tasks add column if not exists parent_task_id uuid references public.tasks(id) on delete set null;
alter table public.tasks add column if not exists thread_id uuid references public.tasks(id) on delete set null;
alter table public.tasks add column if not exists handed_off_to uuid references public.profiles(id);
alter table public.tasks add column if not exists handed_off_at timestamptz;
create index if not exists tasks_thread_idx on public.tasks(thread_id) where thread_id is not null;
-- Na jednu úlohu sa dá odpovedať iba raz (odpoveď ju zavrie), reťaz je lineárna.
create unique index if not exists tasks_parent_unique_idx on public.tasks(parent_task_id) where parent_task_id is not null;

-- ── 2) api_handoff_task ──────────────────────────────────────────────────────
create or replace function public.api_handoff_task(
  p_task_id uuid,
  p_new_id uuid,
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
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid();
  v_orig public.tasks;
  v_new public.tasks;
  v_notes text := nullif(trim(coalesce(p_notes,'')),'');
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_new_id is null or p_new_id = p_task_id then raise exception 'INVALID_HANDOFF'; end if;
  select * into v_orig from public.tasks where id=p_task_id for update;
  if v_orig.id is null or v_orig.pair_id is distinct from public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if v_orig.assigned_to<>v_user then raise exception 'ONLY_ASSIGNEE_CAN_HANDOFF'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'handoff',p_task_id) then
    select * into v_new from public.tasks where id=p_new_id and parent_task_id=p_task_id;
    if v_new.id is null then raise exception 'MUTATION_RESULT_MISSING'; end if;
    return jsonb_build_object('original',to_jsonb(v_orig),'task',to_jsonb(v_new));
  end if;
  if v_orig.deleted_at is not null then raise exception 'TASK_DELETED'; end if;
  -- Odpovedať sa dá iba na aktívnu úlohu (splnenú/odmietnutú/posunutú nie).
  if v_orig.status<>'pending' then raise exception 'TASK_NOT_EDITABLE'; end if;
  if v_notes is null then raise exception 'HANDOFF_NOTE_REQUIRED'; end if;
  if p_assigned_to is null or p_assigned_to=v_user
     or not exists(select 1 from public.pair_members where pair_id=v_orig.pair_id and user_id=p_assigned_to) then
    raise exception 'INVALID_ASSIGNEE';
  end if;
  if not exists(select 1 from pg_timezone_names where name=coalesce(nullif(p_timezone,''),'Europe/Bratislava')) then raise exception 'INVALID_TIMEZONE'; end if;

  update public.tasks
  set status='handed_off',handed_off_to=p_assigned_to,handed_off_at=now(),snoozed_until=null,
      updated_at=now(),version=version+1,last_changed_by=v_user
  where id=p_task_id returning * into v_orig;
  perform public.cancel_task_notification_jobs(p_task_id);
  update public.notification_jobs set status='cancelled'
  where task_id=p_task_id and kind='task_assigned' and status in ('queued','processing');

  insert into public.tasks(
    id,pair_id,created_by,assigned_to,title,notes,due_at,timezone,priority,pre_reminder_minutes,
    recurrence_rule,recurrence_mode,series_id,occurrence_at,notify_creator_on_complete,
    reminder_interval_seconds,max_reminders,last_changed_by,parent_task_id,thread_id
  ) values (
    p_new_id,v_orig.pair_id,v_user,p_assigned_to,trim(p_title),v_notes,p_due_at,coalesce(nullif(p_timezone,''),'Europe/Bratislava'),
    p_priority,p_pre_reminder_minutes,p_recurrence_rule,p_recurrence_mode,p_new_id,p_due_at,p_notify_creator_on_complete,
    p_reminder_interval_seconds,p_max_reminders,v_user,v_orig.id,coalesce(v_orig.thread_id,v_orig.id)
  ) returning * into v_new;

  insert into public.task_events(task_id,pair_id,actor_id,event_type,payload) values
    (v_orig.id,v_orig.pair_id,v_user,'handed_off',jsonb_build_object('to',p_assigned_to,'new_task_id',v_new.id)),
    (v_new.id,v_new.pair_id,v_user,'created',jsonb_build_object('parent_task_id',v_orig.id));
  insert into public.notification_jobs(task_id,recipient_id,kind,scheduled_at,dedupe_key)
  values(v_new.id,p_assigned_to,'task_assigned',now(),'task-assigned:'||v_new.id)
  on conflict(dedupe_key) do nothing;
  perform public.enqueue_task_notification_jobs(v_new);

  -- Opakovaná úloha pokračuje ako po splnení; zlyhanie plánovania nesmie
  -- vrátiť späť samotné posunutie.
  if v_orig.recurrence_rule<>'none' and v_orig.recurrence_mode='after' then
    begin
      perform public.create_next_recurring_task(v_orig);
    exception when others then
      raise warning 'Nezabudni: naplanovanie dalsieho vyskytu zlyhalo (task %): %', v_orig.id, sqlerrm;
    end;
  end if;
  return jsonb_build_object('original',to_jsonb(v_orig),'task',to_jsonb(v_new));
end;
$$;
revoke all on function public.api_handoff_task(uuid,uuid,uuid,uuid,text,text,timestamptz,text,integer,integer,text,text,boolean,integer,integer) from public,anon;
grant execute on function public.api_handoff_task(uuid,uuid,uuid,uuid,text,text,timestamptz,text,integer,integer,text,text,boolean,integer,integer) to authenticated;

create or replace function public.get_backend_capabilities()
returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object('schema_version',18,'group_invitations',true,'integration_read_tasks',true,'integration_attachments',true,'task_handoff',true);
$$;
revoke all on function public.get_backend_capabilities() from public,anon;
grant execute on function public.get_backend_capabilities() to authenticated;
commit;

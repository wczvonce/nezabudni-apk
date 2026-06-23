-- Nezabudni v19 – Issue 12: odmietnutie s POVINNÝM dôvodom + "odstrániť zo svojho zoznamu".
-- Spusti po 001/004. Aditívne a bezpečné spustiť opakovane.

-- 1) Nový terminálny stav 'rejected' + dôvod odmietnutia.
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check check (status in ('pending','completed','cancelled','rejected'));
alter table public.tasks add column if not exists rejection_reason text;
alter table public.tasks add column if not exists rejected_by uuid references public.profiles(id);
alter table public.tasks add column if not exists rejected_at timestamptz;

-- 2) Per-používateľské skrytie úlohy z VLASTNÉHO zoznamu (nemaže autorov záznam,
--    neovplyvní ostatných používateľov).
create table if not exists public.task_hidden (
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
alter table public.task_hidden enable row level security;
drop policy if exists task_hidden_own_select on public.task_hidden;
create policy task_hidden_own_select on public.task_hidden for select to authenticated using (user_id = auth.uid());
-- Zápis iba cez security-definer RPC; priame INSERT/UPDATE/DELETE klient nemá.
revoke all on public.task_hidden from anon, authenticated;
grant select on public.task_hidden to authenticated;

-- 3) api_reject_task – iba priradený príjemca, s POVINNÝM dôvodom (enforcuje backend).
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
  if v_task.id is null or v_task.pair_id<>public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if v_task.assigned_to<>v_user then raise exception 'ONLY_ASSIGNEE_CAN_REJECT'; end if;
  if public.mutation_is_duplicate(p_mutation_id,'reject',p_task_id) then return v_task; end if;
  if v_task.status<>'pending' then return v_task; end if;
  update public.tasks set status='rejected',rejection_reason=v_reason,rejected_by=v_user,rejected_at=now(),
    snoozed_until=null,acknowledged_by=null,acknowledged_at=null,updated_at=now(),version=version+1,last_changed_by=v_user
  where id=p_task_id returning * into v_task;
  perform public.cancel_task_notification_jobs(p_task_id);
  -- Autor uvidí odmietnutie + dôvod cez realtime sync (záznam úlohy ho nesie).
  insert into public.task_events(task_id,pair_id,actor_id,event_type,payload)
  values(v_task.id,v_task.pair_id,v_user,'rejected',jsonb_build_object('reason',v_reason));
  return v_task;
end;
$$;
revoke all on function public.api_reject_task(uuid,text,uuid) from public, anon;
grant execute on function public.api_reject_task(uuid,text,uuid) to authenticated;

-- 4) api_hide_task_for_self – odstránenie z VLASTNÉHO zoznamu až po dokončení/odmietnutí.
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
  if v_task.id is null or v_task.pair_id<>public.current_pair_id() then raise exception 'TASK_NOT_FOUND'; end if;
  if v_user not in (v_task.assigned_to, v_task.created_by) then raise exception 'NOT_ALLOWED'; end if;
  -- Odstrániť zo zoznamu možno iba úlohu, ktorá už nie je aktívna.
  if v_task.status = 'pending' then raise exception 'TASK_STILL_ACTIVE'; end if;
  insert into public.task_hidden(task_id,user_id) values(p_task_id,v_user) on conflict do nothing;
end;
$$;
revoke all on function public.api_hide_task_for_self(uuid) from public, anon;
grant execute on function public.api_hide_task_for_self(uuid) to authenticated;

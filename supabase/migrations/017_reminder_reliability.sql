-- Nezabudni v19 – 017: spoľahlivosť opakovania a pripomienok (údržba 1.0.18).
-- Spusti po 001..016. Bezpečné spustiť opakovane (create or replace / revoke).
--
-- Opravy v tejto migrácii:
--  1) api_generate_recurring_occurrences: séria „v každom termíne" sa dala
--     zastaviť len vymazaním/vypnutím VŠETKÝCH výskytov. Generátor vyberal
--     najnovší výskyt až PO odfiltrovaní zmazaných a vypnutých, takže keď
--     používateľ aktuálny výskyt vymazal alebo mu dal „Opakovanie: žiadne",
--     server po jeho termíne vytvoril nový výskyt zo staršieho, ešte
--     opakujúceho sa výskytu. Teraz rozhoduje skutočne najnovší výskyt série:
--     zmazaný alebo vypnutý najnovší výskyt sériu ukončí.
--  2) api_register_device: pripomienky (task_pre/task_due/task_repeat), ktoré
--     čakali na retry kvôli NO_ACTIVE_SUBSCRIPTIONS, sa po opätovnej
--     registrácii zariadenia hneď vrátia do fronty. Predtým čakali až 15 min a
--     worker ich medzitým zrušil ako príliš staré – séria pípania po krátkom
--     výpadku push registrácie skončila predčasne (reálne 2026-10-27: 4 z 10).
--  3) mark_notification_failed: pripomienky bez aktívneho zariadenia sa skúšajú
--     každé 2 minúty (nie 15), aby sa po obnovení registrácie stihli doručiť
--     v okne, kým ich worker nepovažuje za zastarané. Ostatné typy ostávajú.
--  4) Odobratý EXECUTE pre rolu anon na SECURITY DEFINER RPC funkciách (Supabase
--     ho pridáva cez default privileges). Funkcie sa bránili kontrolou
--     auth.uid(), toto je obrana do hĺbky (Supabase advisor 0028).
--  5) touch_updated_at: pevný search_path (Supabase advisor 0011).
begin;

-- ── 1) api_generate_recurring_occurrences: rozhoduje najnovší výskyt série ───
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
      -- Najnovší výskyt KAŽDEJ série, ktorá niekedy opakovala „v každom termíne",
      -- vrátane zmazaných a vypnutých výskytov. Filtrovanie až potom zaručí, že
      -- zmazanie / vypnutie opakovania na aktuálnom výskyte sériu ukončí.
      select distinct on (t.series_id) t.*
      from public.tasks t
      where t.series_id in (
        select s.series_id from public.tasks s
        where s.recurrence_rule<>'none' and s.recurrence_mode='each'
      )
      order by t.series_id, t.occurrence_at desc, t.created_at desc
    ) latest
    where latest.recurrence_rule<>'none'
      and latest.recurrence_mode='each'
      and latest.deleted_at is null
      and latest.occurrence_at<=now()
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
revoke all on function public.api_generate_recurring_occurrences() from public,anon,authenticated;
grant execute on function public.api_generate_recurring_occurrences() to service_role;

-- ── 2) api_register_device: hneď obnov čakajúce pripomienky ──────────────────
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
  -- Nové v 017: čakajúce pripomienky (retry kvôli chýbajúcemu zariadeniu) pošli
  -- hneď. Worker si sám overí, či úloha ešte čaká a či pripomienka nie je
  -- zastaraná (shouldCancel), takže sa nepošle nič neaktuálne.
  update public.notification_jobs
  set scheduled_at=now(),locked_at=null
  where recipient_id=v_user
    and status='queued'
    and kind in ('task_pre','task_due','task_repeat')
    and last_error like '%NO_ACTIVE_SUBSCRIPTIONS%'
    and scheduled_at>now();
  return v_row;
end;
$$;
revoke all on function public.api_register_device(text,text,uuid,text) from public,anon;
grant execute on function public.api_register_device(text,text,uuid,text) to authenticated;

-- ── 3) mark_notification_failed: rýchlejší retry pripomienok bez zariadenia ──
create or replace function public.mark_notification_failed(p_job_id uuid,p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
  v_kind text;
  v_max_attempts integer;
  v_delay interval;
begin
  select attempt_count,kind into v_attempts,v_kind from public.notification_jobs where id=p_job_id and status='processing';
  if v_attempts is null then return; end if;
  if p_error like '%NO_ACTIVE_SUBSCRIPTIONS%' then
    v_max_attempts:=96;
    -- Pripomienky sú časovo citlivé: worker ich po okne série zruší, takže
    -- 15-minútový retry by po krátkom výpadku zahodil zvyšok série.
    v_delay:=case when v_kind in ('task_pre','task_due','task_repeat') then interval '2 minutes' else interval '15 minutes' end;
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
revoke all on function public.mark_notification_failed(uuid,text) from public,anon,authenticated;
grant execute on function public.mark_notification_failed(uuid,text) to service_role;

-- ── 4) anon nesmie volať SECURITY DEFINER RPC funkcie ────────────────────────
revoke execute on function public.api_acknowledge_task(uuid,uuid) from anon;
revoke execute on function public.api_complete_task(uuid,uuid) from anon;
revoke execute on function public.api_create_task(uuid,uuid,uuid,text,text,timestamptz,text,integer,integer,text,text,boolean,integer,integer) from anon;
revoke execute on function public.api_delete_task(uuid,uuid) from anon;
revoke execute on function public.api_register_device(text,text,uuid,text) from anon;
revoke execute on function public.api_send_test_notification() from anon;
revoke execute on function public.api_unregister_device(text) from anon;
revoke execute on function public.api_unregister_install(uuid) from anon;
revoke execute on function public.api_update_task(uuid,uuid,bigint,uuid,text,text,timestamptz,text,integer,integer,text,text,boolean,integer,integer) from anon;
revoke execute on function public.current_pair_id() from anon;

-- ── 5) touch_updated_at: pevný search_path ──────────────────────────────────
alter function public.touch_updated_at() set search_path = public, pg_temp;

create or replace function public.get_backend_capabilities()
returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object('schema_version',17,'group_invitations',true,'integration_read_tasks',true,'integration_attachments',true);
$$;
revoke all on function public.get_backend_capabilities() from public,anon;
grant execute on function public.get_backend_capabilities() to authenticated;
commit;

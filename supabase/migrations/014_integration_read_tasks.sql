-- Additive integration read capability. Existing clients keep their exact scopes.
begin;

alter table public.integration_clients drop constraint integration_clients_allowed_operations_check;
alter table public.integration_clients add constraint integration_clients_allowed_operations_check
  check (cardinality(allowed_operations) between 1 and 20
    and allowed_operations <@ array['create_task','read_tasks','upload_attachment']::text[]);

create function public.api_read_tasks_from_integration(
  p_client_id uuid, p_actor_id uuid, p_task_id uuid default null,
  p_assignee uuid default null, p_status text default null,
  p_from timestamptz default null, p_to timestamptz default null,
  p_query text default null, p_limit integer default 50, p_offset integer default 0
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_client public.integration_clients;
  v_pair uuid;
  v_result jsonb;
begin
  select * into v_client from public.integration_clients where id=p_client_id for share;
  if not found or not v_client.active or v_client.expires_at<=now()
    or p_actor_id is null or v_client.actor_id<>p_actor_id then
    raise exception 'INTEGRATION_UNAUTHORIZED';
  end if;
  if not ('read_tasks'=any(v_client.allowed_operations)) then
    raise exception 'INTEGRATION_OPERATION_NOT_ALLOWED';
  end if;
  select pair_id into v_pair from public.pair_members where user_id=p_actor_id;
  if v_pair is null then raise exception 'PAIR_REQUIRED'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 or p_offset is null or p_offset<0 or p_offset>10000
    or char_length(coalesce(p_query,''))>180
    or (p_status is not null and p_status not in ('pending','completed','cancelled','rejected'))
    or (p_from is not null and p_to is not null and p_from>p_to) then
    raise exception 'INVALID_TASK_FILTER';
  end if;
  -- A supplied foreign assignee is not evidence that the user exists elsewhere.
  if p_assignee is not null and not exists (
    select 1 from public.pair_members where pair_id=v_pair and user_id=p_assignee
  ) then raise exception 'INVALID_ASSIGNEE'; end if;

  select coalesce(jsonb_agg(item order by due_at,id),'[]'::jsonb) into v_result from (
    select t.due_at,t.id,jsonb_build_object(
      'id',t.id,'title',t.title,'notes',t.notes,'due_at',t.due_at,
      'timezone',t.timezone,
      'local_date',to_char(t.due_at at time zone 'Europe/Bratislava','YYYY-MM-DD'),
      'local_time',to_char(t.due_at at time zone 'Europe/Bratislava','HH24:MI'),
      'status',t.status,'notify_creator_on_complete',t.notify_creator_on_complete,
      'assigned_to',jsonb_build_object('id',t.assigned_to,'display_name',assignee.display_name),
      'created_by',jsonb_build_object('id',t.created_by,'display_name',creator.display_name),
      'attachment_count',(select count(*) from public.task_attachments a where a.task_id=t.id and a.pair_id=v_pair),
      'attachments',coalesce((select jsonb_agg(jsonb_build_object(
        'id',a.id,'filename',a.filename,'mime_type',a.mime_type,'size_bytes',a.size_bytes,
        'created_at',a.created_at) order by a.created_at,a.id)
        from public.task_attachments a where a.task_id=t.id and a.pair_id=v_pair),'[]'::jsonb)
    ) as item
    from public.tasks t
    join public.profiles assignee on assignee.id=t.assigned_to
    join public.profiles creator on creator.id=t.created_by
    where t.pair_id=v_pair and t.deleted_at is null
      and (p_task_id is null or t.id=p_task_id)
      and (p_assignee is null or t.assigned_to=p_assignee)
      and (p_status is null or t.status=p_status)
      and (p_from is null or t.due_at>=p_from) and (p_to is null or t.due_at<=p_to)
      -- Literal substring search: no SQL or PostgREST filter interpolation.
      and (p_query is null or strpos(lower(t.title),lower(p_query))>0)
    order by t.due_at,t.id limit p_limit offset p_offset
  ) selected;
  return v_result;
end;
$$;
revoke all on function public.api_read_tasks_from_integration(uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,text,integer,integer) from public,anon,authenticated;
grant execute on function public.api_read_tasks_from_integration(uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,text,integer,integer) to service_role;

create or replace function public.get_backend_capabilities()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('schema_version',14,'group_invitations',true,'integration_read_tasks',true);
$$;
revoke all on function public.get_backend_capabilities() from public,anon;
grant execute on function public.get_backend_capabilities() to authenticated;
commit;

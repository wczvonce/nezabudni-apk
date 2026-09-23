-- Pending uploads are not task attachments until the Edge Function verifies bytes.
begin;
create table public.integration_attachment_uploads (
  client_id uuid not null references public.integration_clients(id) on delete cascade,
  request_id uuid not null,
  attachment_id uuid not null unique default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  pair_id uuid not null references public.pairs(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  filename text not null check (char_length(filename) between 1 and 180),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '1 hour',
  completed_at timestamptz,
  primary key (client_id,request_id)
);
alter table public.integration_attachment_uploads enable row level security;
revoke all on public.integration_attachment_uploads from public,anon,authenticated;
grant select,insert,update on public.integration_attachment_uploads to service_role;
create index integration_attachment_uploads_recent on public.integration_attachment_uploads(client_id,created_at);

create function public.integration_require_scope(p_client_id uuid,p_actor_id uuid,p_scope text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_client public.integration_clients; v_pair uuid;
begin
  select * into v_client from public.integration_clients where id=p_client_id for share;
  if not found or not v_client.active or v_client.expires_at<=now()
    or p_actor_id is null or v_client.actor_id<>p_actor_id then raise exception 'INTEGRATION_UNAUTHORIZED'; end if;
  if p_scope is null or not (p_scope=any(v_client.allowed_operations)) then raise exception 'INTEGRATION_OPERATION_NOT_ALLOWED'; end if;
  select pair_id into v_pair from public.pair_members where user_id=p_actor_id;
  if v_pair is null then raise exception 'PAIR_REQUIRED'; end if;
  return v_pair;
end $$;

create function public.api_reserve_integration_attachment(
  p_client_id uuid,p_actor_id uuid,p_request_id uuid,p_task_id uuid,
  p_filename text,p_mime_type text,p_size_bytes integer,p_sha256 text
) returns public.integration_attachment_uploads
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_pair uuid; v_upload public.integration_attachment_uploads; v_id uuid;
begin
  -- Serialize reservations per integration client, including concurrent identical retries.
  perform 1 from public.integration_clients where id=p_client_id for update;
  v_pair:=public.integration_require_scope(p_client_id,p_actor_id,'upload_attachment');
  if p_request_id is null or p_task_id is null or p_filename is null
    or char_length(p_filename) not between 1 and 180 or p_filename<>trim(p_filename)
    or p_filename ~ '[[:cntrl:]/\\]'
    or p_mime_type is null or p_mime_type not in ('image/jpeg','image/png','image/webp','application/pdf')
    or p_size_bytes is null or p_size_bytes not between 1 and 10485760
    or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_ATTACHMENT'; end if;
  if not exists(select 1 from public.tasks where id=p_task_id and pair_id=v_pair and deleted_at is null) then raise exception 'TASK_NOT_FOUND'; end if;
  select * into v_upload from public.integration_attachment_uploads where client_id=p_client_id and request_id=p_request_id;
  if found then
    if v_upload.actor_id<>p_actor_id or v_upload.pair_id<>v_pair then raise exception 'INTEGRATION_UNAUTHORIZED'; end if;
    if v_upload.task_id<>p_task_id or v_upload.filename<>p_filename or v_upload.mime_type<>p_mime_type
      or v_upload.size_bytes<>p_size_bytes or v_upload.sha256<>p_sha256 then raise exception 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'; end if;
    if v_upload.completed_at is null and v_upload.expires_at<=now() then raise exception 'UPLOAD_EXPIRED'; end if;
    return v_upload;
  end if;
  if (select count(*) from public.integration_attachment_uploads where client_id=p_client_id and created_at>now()-interval '24 hours')>=100 then
    raise exception 'INTEGRATION_DAILY_LIMITED';
  end if;
  if (select count(*) from public.integration_attachment_uploads where client_id=p_client_id and created_at>now()-interval '1 minute')>=5 then
    raise exception 'INTEGRATION_RATE_LIMITED';
  end if;
  v_id:=gen_random_uuid();
  insert into public.integration_attachment_uploads(client_id,request_id,attachment_id,task_id,pair_id,actor_id,filename,mime_type,size_bytes,sha256,storage_path)
    values(p_client_id,p_request_id,v_id,p_task_id,v_pair,p_actor_id,p_filename,p_mime_type,p_size_bytes,p_sha256,
      v_pair::text||'/'||p_task_id::text||'/'||v_id::text)
    returning * into v_upload;
  return v_upload;
end $$;

create function public.api_get_integration_upload(p_client_id uuid,p_actor_id uuid,p_request_id uuid)
returns public.integration_attachment_uploads language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_pair uuid; v_upload public.integration_attachment_uploads;
begin
  v_pair:=public.integration_require_scope(p_client_id,p_actor_id,'upload_attachment');
  select u.* into v_upload from public.integration_attachment_uploads u
    join public.tasks t on t.id=u.task_id and t.pair_id=v_pair and t.deleted_at is null
    where u.client_id=p_client_id and u.request_id=p_request_id and u.pair_id=v_pair and u.actor_id=p_actor_id;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  if v_upload.completed_at is null and v_upload.expires_at<=now() then raise exception 'UPLOAD_EXPIRED'; end if;
  return v_upload;
end $$;

create function public.api_finalize_integration_attachment(p_client_id uuid,p_actor_id uuid,p_request_id uuid)
returns public.task_attachments language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_upload public.integration_attachment_uploads; v_attachment public.task_attachments;
begin
  -- Only trusted service-role callers, after downloading and verifying the stored bytes.
  v_upload:=public.api_get_integration_upload(p_client_id,p_actor_id,p_request_id);
  select * into v_upload from public.integration_attachment_uploads where client_id=p_client_id and request_id=p_request_id for update;
  perform 1 from public.tasks where id=v_upload.task_id and pair_id=v_upload.pair_id and deleted_at is null for share;
  if not found then raise exception 'TASK_NOT_FOUND'; end if;
  if v_upload.completed_at is not null then
    select * into v_attachment from public.task_attachments where id=v_upload.attachment_id;
    if not found then raise exception 'ATTACHMENT_NOT_FOUND'; end if;
    return v_attachment;
  end if;
  if not exists(select 1 from storage.objects where bucket_id='task-attachments' and name=v_upload.storage_path) then raise exception 'UPLOAD_NOT_STORED'; end if;
  insert into public.task_attachments(id,task_id,pair_id,uploaded_by,storage_path,filename,mime_type,size_bytes)
    values(v_upload.attachment_id,v_upload.task_id,v_upload.pair_id,p_actor_id,v_upload.storage_path,v_upload.filename,v_upload.mime_type,v_upload.size_bytes)
    on conflict(id) do nothing;
  select * into v_attachment from public.task_attachments where id=v_upload.attachment_id;
  update public.integration_attachment_uploads set completed_at=coalesce(completed_at,now()) where client_id=p_client_id and request_id=p_request_id;
  return v_attachment;
end $$;

create function public.api_read_integration_attachment(p_client_id uuid,p_actor_id uuid,p_task_id uuid,p_attachment_id uuid)
returns public.task_attachments language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_pair uuid; v_attachment public.task_attachments;
begin
  v_pair:=public.integration_require_scope(p_client_id,p_actor_id,'read_tasks');
  select a.* into v_attachment from public.task_attachments a join public.tasks t on t.id=a.task_id
    where a.id=p_attachment_id and a.task_id=p_task_id and a.pair_id=v_pair and t.pair_id=v_pair and t.deleted_at is null;
  if not found then raise exception 'ATTACHMENT_NOT_FOUND'; end if;
  return v_attachment;
end $$;

revoke all on function public.integration_require_scope(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.api_reserve_integration_attachment(uuid,uuid,uuid,uuid,text,text,integer,text) from public,anon,authenticated;
revoke all on function public.api_get_integration_upload(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.api_finalize_integration_attachment(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.api_read_integration_attachment(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.integration_require_scope(uuid,uuid,text) to service_role;
grant execute on function public.api_reserve_integration_attachment(uuid,uuid,uuid,uuid,text,text,integer,text) to service_role;
grant execute on function public.api_get_integration_upload(uuid,uuid,uuid) to service_role;
grant execute on function public.api_finalize_integration_attachment(uuid,uuid,uuid) to service_role;
grant execute on function public.api_read_integration_attachment(uuid,uuid,uuid,uuid) to service_role;

create or replace function public.get_backend_capabilities()
returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object('schema_version',15,'group_invitations',true,'integration_read_tasks',true,'integration_attachments',true);
$$;
revoke all on function public.get_backend_capabilities() from public,anon;
grant execute on function public.get_backend_capabilities() to authenticated;
commit;

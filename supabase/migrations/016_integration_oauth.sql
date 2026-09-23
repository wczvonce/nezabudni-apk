-- Install before enabling OAuth. Configure the token hook separately after backup/review.
begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='nezabudni_mcp') then
    create role nezabudni_mcp nologin noinherit;
  end if;
end $$;
grant nezabudni_mcp to authenticator;
-- This role is deliberately NOT a member of authenticated and receives no table/RPC grants.

create table public.integration_oauth_apps (
  oauth_client_id uuid primary key,
  name text not null check(char_length(name) between 1 and 120),
  resource_uri text not null check(resource_uri ~ '^https://[^?#]+$'),
  active boolean not null default true,
  allowed_operations text[] not null default array['create_task','read_tasks','upload_attachment']::text[],
  check(cardinality(allowed_operations) between 1 and 3 and allowed_operations <@ array['create_task','read_tasks','upload_attachment']::text[])
);
alter table public.integration_oauth_apps enable row level security;
revoke all on public.integration_oauth_apps from public,anon,authenticated;
grant select,insert,update,delete on public.integration_oauth_apps to service_role;
alter table public.integration_clients add column oauth_client_id uuid references public.integration_oauth_apps(oauth_client_id);
create unique index integration_clients_oauth_actor on public.integration_clients(actor_id,oauth_client_id) where oauth_client_id is not null;

create function public.approve_integration_oauth(p_oauth_client_id uuid,p_operations text[])
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_actor uuid:=auth.uid(); v_app public.integration_oauth_apps; v_id uuid;
begin
  -- Only a first-party login may grant authority. An OAuth token cannot grant itself more.
  if v_actor is null or nullif(auth.jwt()->>'client_id','') is not null then raise exception 'FIRST_PARTY_LOGIN_REQUIRED'; end if;
  if not exists(select 1 from public.pair_members where user_id=v_actor) then raise exception 'PAIR_REQUIRED'; end if;
  select * into v_app from public.integration_oauth_apps where oauth_client_id=p_oauth_client_id and active for share;
  if not found then raise exception 'OAUTH_APP_NOT_ALLOWED'; end if;
  if p_operations is null or cardinality(p_operations)<1 or not (p_operations<@v_app.allowed_operations)
    or array_position(p_operations,null) is not null then raise exception 'INVALID_OPERATIONS'; end if;
  -- Serialize concurrent consent for one user without locking any other user's grant.
  perform 1 from public.profiles where id=v_actor for update;
  select id into v_id from public.integration_clients where actor_id=v_actor and oauth_client_id=p_oauth_client_id;
  if found then
    update public.integration_clients set active=true,allowed_operations=p_operations,
      expires_at=now()+interval '180 days' where id=v_id;
  else
    insert into public.integration_clients(name,actor_id,token_hash,allowed_operations,oauth_client_id)
      values(v_app.name,v_actor,encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex'),p_operations,p_oauth_client_id)
      returning id into v_id;
  end if;
  return v_id;
end $$;

create function public.revoke_integration_oauth(p_oauth_client_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or nullif(auth.jwt()->>'client_id','') is not null then raise exception 'FIRST_PARTY_LOGIN_REQUIRED'; end if;
  update public.integration_clients set active=false where actor_id=auth.uid() and oauth_client_id=p_oauth_client_id;
end $$;

create function public.nezabudni_oauth_access_token_hook(event jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  v_claims jsonb:=event->'claims';
  v_client text:=coalesce(nullif(event->>'client_id',''),nullif(event->'claims'->>'client_id',''));
  v_app public.integration_oauth_apps;
  v_grant public.integration_clients;
begin
  -- Byte-for-byte JSON claims preservation for ordinary app sign-ins and refreshes.
  if v_client is null then
    if event->>'authentication_method'='oauth_provider/authorization_code' then raise exception 'OAUTH_CLIENT_REQUIRED'; end if;
    return jsonb_build_object('claims',v_claims);
  end if;
  select * into v_app from public.integration_oauth_apps where oauth_client_id=v_client::uuid and active;
  if not found then raise exception 'OAUTH_APP_NOT_ALLOWED'; end if;
  select * into v_grant from public.integration_clients where oauth_client_id=v_app.oauth_client_id
    and actor_id=(v_claims->>'sub')::uuid and active and expires_at>now();
  if not found then raise exception 'OAUTH_CONSENT_REQUIRED'; end if;
  if not (v_grant.allowed_operations<@v_app.allowed_operations) then raise exception 'OAUTH_CONSENT_REQUIRED'; end if;
  v_claims:=v_claims||jsonb_build_object('role','nezabudni_mcp','aud',v_app.resource_uri,
    'client_id',v_client,'integration_id',v_grant.id,'scope','openid '||array_to_string(v_grant.allowed_operations,' '));
  return jsonb_build_object('claims',v_claims);
end $$;

revoke all on function public.approve_integration_oauth(uuid,text[]) from public,anon;
revoke all on function public.revoke_integration_oauth(uuid) from public,anon;
grant execute on function public.approve_integration_oauth(uuid,text[]) to authenticated;
grant execute on function public.revoke_integration_oauth(uuid) to authenticated;
revoke all on function public.nezabudni_oauth_access_token_hook(jsonb) from public,anon,authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.nezabudni_oauth_access_token_hook(jsonb) to supabase_auth_admin;

create or replace function public.get_backend_capabilities()
returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object('schema_version',16,'group_invitations',true,'integration_read_tasks',true,'integration_attachments',true);
$$;
revoke all on function public.get_backend_capabilities() from public,anon;
grant execute on function public.get_backend_capabilities() to authenticated;
commit;

-- Rozšírenie existujúcej dvojice na spoločnú skupinu. Existujúce úlohy,
-- api_create_task a notifikačná fronta sa nemenia. Všetci členovia vidia skupinu.
begin;

create table public.group_invitations (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references public.pairs(id),
  created_by uuid not null references public.profiles(id),
  email text not null check (length(email) between 3 and 254),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id)
);
create index group_invitations_pair_idx on public.group_invitations(pair_id, created_at);
alter table public.group_invitations enable row level security;
revoke all on public.group_invitations from public, anon, authenticated;

-- Preserve the original meaning of ChatGPT "partner" before a third member
-- joins. Never infer a different partner from an unordered profile query.
create table public.pair_primary_partners (
  actor_id uuid primary key,
  partner_id uuid not null,
  pair_id uuid not null,
  check (actor_id <> partner_id),
  foreign key (pair_id, actor_id) references public.pair_members(pair_id, user_id),
  foreign key (pair_id, partner_id) references public.pair_members(pair_id, user_id)
);
alter table public.pair_primary_partners enable row level security;
revoke all on public.pair_primary_partners from public, anon, authenticated;
grant select on public.pair_primary_partners to service_role;
insert into public.pair_primary_partners(actor_id, partner_id, pair_id)
select a.user_id, b.user_id, a.pair_id from public.pair_members a
join public.pair_members b on a.pair_id = b.pair_id and a.user_id <> b.user_id
where (select count(*) from public.pair_members m where m.pair_id = a.pair_id) = 2;

create function public.create_group_invitation(p_email text, p_token_hash text, p_ack_all_tasks boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_pair uuid; v_row public.group_invitations; v_email text := lower(trim(p_email));
begin
  select pair_id into v_pair from public.pair_members where user_id = auth.uid() and role = 'owner';
  if v_pair is null then raise exception 'GROUP_OWNER_REQUIRED'; end if;
  if p_ack_all_tasks is distinct from true then raise exception 'SHARED_TASKS_CONFIRMATION_REQUIRED'; end if;
  if v_email is null or length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_INVITATION'; end if;
  perform 1 from public.pairs where id = v_pair for update;
  if (select count(*) from public.pair_members where pair_id = v_pair) >= 20 then raise exception 'GROUP_FULL'; end if;
  if exists(select 1 from public.pair_members m join public.profiles p on p.id=m.user_id where m.pair_id=v_pair and lower(p.email)=v_email) then raise exception 'ALREADY_MEMBER'; end if;
  if exists(select 1 from public.group_invitations where pair_id=v_pair and email=v_email and accepted_at is null and revoked_at is null and expires_at>now()) then raise exception 'INVITATION_ALREADY_ACTIVE'; end if;
  if (select count(*) from public.group_invitations where pair_id=v_pair and created_at>now()-interval '24 hours') >= 20
     or (select count(*) from public.group_invitations where pair_id=v_pair and accepted_at is null and revoked_at is null and expires_at>now()) >= 10 then raise exception 'INVITATION_LIMIT'; end if;
  insert into public.group_invitations(pair_id,created_by,email,token_hash)
  values(v_pair,auth.uid(),v_email,p_token_hash) returning * into v_row;
  return jsonb_build_object('id',v_row.id,'email',v_row.email,'expires_at',v_row.expires_at);
end $$;

create function public.list_group_invitations()
returns table(id uuid,email text,expires_at timestamptz,revoked_at timestamptz,accepted_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_pair uuid;
begin
  select pair_id into v_pair from public.pair_members where user_id=auth.uid() and role='owner';
  if v_pair is null then raise exception 'GROUP_OWNER_REQUIRED'; end if;
  return query select i.id,i.email,i.expires_at,i.revoked_at,i.accepted_at from public.group_invitations i
    where i.pair_id=v_pair order by i.created_at desc limit 30;
end $$;

create function public.revoke_group_invitation(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.pair_members where user_id=auth.uid() and role='owner') then raise exception 'GROUP_OWNER_REQUIRED'; end if;
  update public.group_invitations set revoked_at=coalesce(revoked_at,now())
    where id=p_id and pair_id=public.current_pair_id() and accepted_at is null;
  -- Revocation cannot remove somebody who has already joined.
end $$;

create function public.accept_group_invitation(p_code text, p_display_name text, p_ack_all_tasks boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_email text; v_confirmed timestamptz;
  v_inv public.group_invitations; v_existing uuid;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_ack_all_tasks is distinct from true then raise exception 'SHARED_TASKS_CONFIRMATION_REQUIRED'; end if;
  if p_code is null or p_code !~ '^[0-9a-f]{64}$' or p_display_name is null
     or length(trim(p_display_name)) not between 1 and 80 then raise exception 'INVALID_INVITATION'; end if;
  -- Serialize attempts by this account as well as attempts to consume a code.
  select lower(email),email_confirmed_at into v_email,v_confirmed from auth.users where id=v_uid for update;
  if v_confirmed is null then raise exception 'EMAIL_CONFIRMATION_REQUIRED'; end if;
  select * into v_inv from public.group_invitations
    where token_hash=encode(sha256(convert_to(p_code,'UTF8')),'hex') for update;
  if v_inv.id is null or v_inv.email is distinct from v_email then raise exception 'INVITATION_INVALID_OR_EXPIRED'; end if;
  select pair_id into v_existing from public.pair_members where user_id=v_uid;
  if v_inv.accepted_by=v_uid and v_existing=v_inv.pair_id then return v_existing; end if;
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at<=now() then raise exception 'INVITATION_INVALID_OR_EXPIRED'; end if;
  if v_existing is not null then raise exception 'ALREADY_IN_GROUP'; end if;
  if not exists(select 1 from public.pair_members where pair_id=v_inv.pair_id and user_id=v_inv.created_by and role='owner') then raise exception 'INVITATION_INVALID_OR_EXPIRED'; end if;
  perform 1 from public.pairs where id=v_inv.pair_id for update;
  if (select count(*) from public.pair_members where pair_id=v_inv.pair_id) >= 20 then raise exception 'GROUP_FULL'; end if;
  insert into public.profiles(id,display_name,email) values(v_uid,trim(p_display_name),v_email)
    on conflict(id) do update set display_name=excluded.display_name,email=excluded.email;
  insert into public.pair_members(pair_id,user_id,role) values(v_inv.pair_id,v_uid,'member');
  insert into public.pair_primary_partners(actor_id,partner_id,pair_id) values(v_uid,v_inv.created_by,v_inv.pair_id);
  update public.group_invitations set accepted_at=now(),accepted_by=v_uid where id=v_inv.id;
  return v_inv.pair_id;
end $$;

revoke all on function public.create_group_invitation(text,text,boolean) from public,anon;
revoke all on function public.list_group_invitations() from public,anon;
revoke all on function public.revoke_group_invitation(uuid) from public,anon;
revoke all on function public.accept_group_invitation(text,text,boolean) from public,anon;
grant execute on function public.create_group_invitation(text,text,boolean) to authenticated;
grant execute on function public.list_group_invitations() to authenticated;
grant execute on function public.revoke_group_invitation(uuid) to authenticated;
grant execute on function public.accept_group_invitation(text,text,boolean) to authenticated;

create or replace function public.get_backend_capabilities()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('schema_version',13,'group_invitations',true);
$$;
revoke all on function public.get_backend_capabilities() from public,anon;
grant execute on function public.get_backend_capabilities() to authenticated;
commit;

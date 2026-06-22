-- NAJPRV vytvor v Supabase Authentication > Users dva účty:
-- wczvonce@gmail.com a domi.mikloskova@gmail.com
-- Potom spusti tento skript. Je bezpečné spustiť ho opakovane.

do $$
declare
  v_ivan uuid;
  v_dominika uuid;
  v_pair uuid;
begin
  select id into v_ivan from auth.users where lower(email)=lower('wczvonce@gmail.com');
  select id into v_dominika from auth.users where lower(email)=lower('domi.mikloskova@gmail.com');
  if v_ivan is null or v_dominika is null then raise exception 'Najprv vytvor oboch používateľov v Authentication > Users.'; end if;

  insert into public.profiles(id,display_name,email) values(v_ivan,'Ivan Povrazník','wczvonce@gmail.com')
  on conflict(id) do update set display_name=excluded.display_name,email=excluded.email;
  insert into public.profiles(id,display_name,email) values(v_dominika,'Dominika','domi.mikloskova@gmail.com')
  on conflict(id) do update set display_name=excluded.display_name,email=excluded.email;

  if exists (
    select 1
    from public.pair_members a
    join public.pair_members b on a.user_id=v_ivan and b.user_id=v_dominika
    where a.pair_id<>b.pair_id
  ) then
    raise exception 'Používatelia už patria do rozdielnych dvojíc. Najprv oprav členstvá ručne.';
  end if;

  select pair_id into v_pair from public.pair_members where user_id in(v_ivan,v_dominika) limit 1;
  if v_pair is null then
    insert into public.pairs(name) values('Ivan a Dominika') returning id into v_pair;
  end if;
  insert into public.pair_members(pair_id,user_id,role) values(v_pair,v_ivan,'owner') on conflict(user_id) do nothing;
  insert into public.pair_members(pair_id,user_id,role) values(v_pair,v_dominika,'member') on conflict(user_id) do nothing;

  if not exists(select 1 from public.pair_members where pair_id=v_pair and user_id=v_ivan)
     or not exists(select 1 from public.pair_members where pair_id=v_pair and user_id=v_dominika) then
    raise exception 'Dvojicu sa nepodarilo bezpečne vytvoriť.';
  end if;
end $$;

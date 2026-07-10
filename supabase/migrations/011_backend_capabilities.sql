-- 011: capability handshake (audit A4)
-- Klient očakáva funkcie z migrácií po najnovšiu verziu. Bez runtime kontroly
-- sa nekompletne zmigrovaný backend prejavuje náhodnými RPC chybami. Klient si
-- pri štarte vyžiada schema_version a pri nezhode zobrazí zrozumiteľné
-- varovanie namiesto tichého zlyhávania.
-- DÔLEŽITÉ: pri každej ďalšej migrácii zvýš schema_version o 1.

create or replace function public.get_backend_capabilities()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object('schema_version', 11);
$$;

revoke all on function public.get_backend_capabilities() from public;
grant execute on function public.get_backend_capabilities() to authenticated;

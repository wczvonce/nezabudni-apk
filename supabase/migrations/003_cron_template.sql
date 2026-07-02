-- DOPLŇ hodnoty a spusti až po nasadení Edge Function push-worker.
-- PUSH_WORKER_SECRET musí byť dlhý náhodný text a rovnakú hodnotu uložíš do Edge Function secrets.

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- Nahraď URL a SECRET.
-- Vault neupsertuje podľa mena – pri opakovanom spustení (napr. rotácia secretu)
-- by vznikol duplicitný záznam a dotaz bez ORDER BY by mohol nedeterministicky
-- vracať STARÚ hodnotu. Preto najprv zmaž prípadné existujúce záznamy.
delete from vault.secrets where name in ('push_worker_url','push_worker_secret');
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co/functions/v1/push-worker', 'push_worker_url');
select vault.create_secret('REPLACE_WITH_LONG_RANDOM_SECRET', 'push_worker_secret');

select cron.schedule(
  'nezabudni-push-worker-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='push_worker_url' order by created_at desc limit 1),
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='push_worker_secret' order by created_at desc limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

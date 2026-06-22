# Bezpečnostné pravidlá projektu

1. OneSignal REST API kľúč je iba v Supabase Edge Function secrets.
2. Supabase service-role key je iba v Edge Function runtime.
3. Klient posiela `assigned_to`, ale backend overí, že ide o člena tej istej dvojice.
4. `created_by`, `completed_by` a `last_changed_by` určuje backend z `auth.uid()`.
5. Klient nemá priame právo meniť tabuľku `tasks`; zmeny idú cez RPC.
6. Push worker je chránený samostatným `PUSH_WORKER_SECRET`.
7. Každá notifikácia má unikátny `dedupe_key`.
8. Offline mutácie majú UUID a server ich spracuje najviac raz.
9. Mazanie používa `deleted_at`, nie okamžitý SQL DELETE.
10. IndexedDB názov obsahuje UUID prihláseného používateľa.
11. Starý OneSignal kľúč z v18 musí byť zrušený.
12. Stará Netlify `schedule-push` funkcia sa v tomto projekte vôbec nenachádza.

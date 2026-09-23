# Rozšírené integračné API (pracovná verzia)

Tento dokument popisuje implementáciu, nie potvrdenie nasadenia. Pred použitím
na živom projekte musia prejsť migrácie, audit, CI a schválený deployment.
Pôvodné `GET /context` a `POST /reminders` zostávajú kompatibilné.
Všetky cesty sú relatívne k existujúcemu `chatgpt-api` endpointu.

## Oprávnenia

API používa hlavičku `x-nezabudni-action-key`. Nikdy ju nevkladajte do URL,
zdrojového kódu, GitHub komentára ani logu. Token sa overuje cez jeho hash.
Migrácia 014 povoľuje samostatné oprávnenia `create_task`, `read_tasks` a
`upload_attachment`, ale žiadnemu existujúcemu klientovi ich sama nepridáva.

`GET /context` vracia aj členov skupiny. `POST /reminders` môže namiesto pôvodného
`assignee: self|partner` dostať `assignee_id` konkrétneho člena z kontextu.
Oba spôsoby sa nesmú poslať súčasne. Server aj databáza overujú členstvo.

## Čítanie

- `GET /tasks`: filtre `assignee` (ID člena), `status`, `from`, `to` (ISO čas
  s offsetom), `query` (doslovná časť názvu), `limit` (1–100), `offset` (0–10000).
- `GET /tasks/{task_id}`: detail vrátane poznámky, príjemcu, autora, UTC termínu,
  miestneho dátumu/času v Bratislave, stavu a metadát príloh.
- Obe operácie vyžadujú `read_tasks`. Neexistujúca a cudzia úloha vracajú rovnakú 404.
- Pri nenulovom `next_offset` načítajte ďalšiu stranu. Prázdny výsledok prvej
  strany nie je dôkaz duplicity; pred vytvorením hľadajte primerane široko.

## Binárna príloha pre API klienta / Codex

Migrácia 015 pridáva rezervácie uploadu, nie druhý systém používateľských príloh.
Hotové prílohy sú v pôvodnej `task_attachments` a privátnom buckete `task-attachments`.

1. Vygenerujte stabilné UUID `request_id` pre jeden zamýšľaný upload.
2. Spočítajte SHA-256 bajtov súboru a jeho veľkosť.
3. `POST /tasks/{task_id}/attachments` s JSON:

   ```json
   {
     "request_id": "<UUID jedného uploadu>",
     "filename": "doklad.pdf",
     "mime_type": "application/pdf",
     "size_bytes": 12345,
     "sha256": "<64 hex znakov SHA-256 súboru>"
   }
   ```

4. Na relatívnu `upload_path` z odpovede pošlite `PUT` s rovnakou autentifikáciou
   a priamo binárnym telom, nie base64 JSON. Content-Type musí zodpovedať deklarácii
   alebo byť `application/octet-stream`.
5. Server overí veľkosť, signatúru typu a hash, nahrá súbor bez prepísania existujúceho
   objektu, stiahne uložené bajty späť a overí ich. Až potom vytvorí viditeľný záznam prílohy.
6. Po úspechu načítajte úlohu cez `GET /tasks/{task_id}` a overte ID prílohy.
7. `GET /tasks/{task_id}/attachments/{attachment_id}` s oprávnením `read_tasks`
   poskytne krátkodobú URL na stiahnutie, platnú 60 sekúnd. Považujte ju za citlivú.

Povolené sú JPEG, PNG, WebP a PDF, najviac 10 MiB. Signatúra typu nie je antivírus
ani úplná validácia dokumentu. Súbory sa neposielajú späť ako inline HTML.
Rezervácia je platná hodinu. Limity sú 5 nových rezervácií za minútu a 100 za 24 hodín.
Retry s rovnakými metadátami vráti rovnaké ID; zmena obsahu alebo metadát s rovnakým
`request_id` znamená konflikt. Retry hotovej prílohy nevytvára ďalší záznam.
Ak používateľ hotovú prílohu medzičasom odstránil, retry ju neobnoví.

## Bezpečnostné hranice a prevádzka

Storage cestu tvorí výlučne server z ID skupiny, úlohy a prílohy. Klient ju nemôže
zadať. Interné RPC môže volať iba service role backendu, nie mobilný používateľ
ani anonymný návštevník. Mobilné RPC, existujúce stĺpce tasks a push-worker sa nemenia.

Prerušený upload môže ponechať objekt bez hotovej prílohy. Automatické mazanie
neimplementujeme: prípadné čistenie musí overiť rezerváciu, stav a konkrétny objekt
a vyžaduje samostatný prevádzkový postup. Databázový rollback sa nerobí automaticky.

Celý konektor vypnete zmenou `integration_clients.active` na `false` pre jeho
konkrétne ID; upload alebo čítanie samotné možno odobrať z `allowed_operations`.
Nikdy nevypínajte ani nemažte všetkých klientov hromadne.

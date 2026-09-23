# Nezabudni MCP – príprava a pripojenie

Stav tohto dokumentu: implementované lokálne, nie potvrdenie živého nasadenia.
Konektor nezapínajte pred vykonaním nižšie uvedených deployment kontrol.

## Server a nástroje

Plánovaná MCP URL pre existujúci projekt:

`https://ofwouqpqzcpjnigcgygz.supabase.co/functions/v1/nezabudni-mcp`

Používa OAuth authorization-code + PKCE cez Supabase, nie service-role kľúč ani
Action API key. Streamable HTTP obsluhuje pripnuté oficiálne MCP SDK.
Existujúca Custom GPT Action s vlastným tokenom zostáva samostatne funkčná.

Nástroje:

- `get_nezabudni_context`
- `search_nezabudni_tasks`
- `get_nezabudni_task`
- `create_nezabudni_task`
- `add_nezabudni_attachment`
- `get_nezabudni_attachment`

V zozname sa zobrazia iba nástroje dovolené aktuálnym integračným klientom.
Všetky operácie využívajú rovnaké backendové funkcie ako REST API.
Create má stabilný `request_id`; pri povolenom čítaní server úlohu hneď znovu
načíta do `verified_task`. Upload vracia ID prílohy až po kontrole uložených bajtov.

## Povinné kroky administrátora pred pripojením

1. Overiť vetvu, projekt, checkpoint na GitHube, externú DB zálohu a históriu migrácií.
2. Zelený kompletný audit a CI. Overiť kompatibilitu Android 1.0.17.
3. Skontrolovať dry-run: nové migrácie 014, 015 a 016, žiadne staré migrácie alebo reset.
   Získať výslovné potvrdenie pred DB push.
4. Nasadiť migrácie. Vytvárajú iba integračné objekty a capability verziu16;
   nemenia pôvodné stĺpce tasks, mobilné create RPC ani push-worker.
5. Nasadiť web so samostatnou stránkou `/oauth/consent.html` a overiť jej dostupnosť,
   no-store a bezpečnostné hlavičky. Nezamieňať existujúci web s novým buildom.
6. Skontrolovať existujúci Custom Access Token Hook. Ak už existuje, neprepísať
   ho automaticky; treba posúdiť bezpečné zlúčenie jeho správania.
7. Nastaviť hook `public.nezabudni_oauth_access_token_hook` ako Supabase Custom
   Access Token Hook. Overiť bežné prihlásenie a obnovenie tokenu pôvodnej aplikácie.
8. Až potom nastaviť správny HTTPS Site URL a OAuth authorization path
   `/oauth/consent.html`, povoliť OAuth server. Dynamickú registráciu ponechať vypnutú.
9. Vytvoriť samostatných OAuth klientov pre ChatGPT a podľa potreby Codex s presnou
   callback URL z ich pripájacieho rozhrania. Nepoužiť zástupné callbacky.
10. Pridať iba týchto klientov do `integration_oauth_apps` s MCP resource URI uvedenou
    vyššie a požadovanými operáciami. Do Gitu nikdy nevkladať client secret.
11. Nasadiť `chatgpt-api` a `nezabudni-mcp` s vypnutým gateway JWT checkom;
    obe funkcie vykonávajú vlastnú autentifikáciu. MCP kontroluje podpis, issuer,
    audience, expiráciu, rolu, OAuth klienta a živé integračné povolenie.
12. Overiť discovery, neplatné tokeny, reálny PKCE tok, izoláciu pri priamom
    databázovom volaní, všetky CRUD-v-rozsahu operácie, upload a idempotenciu.

Žiadny integračný token nedostane rolu `authenticated`; MCP token má izolovanú
rolu `nezabudni_mcp`. Bežné prihlásenia aplikácie si zachovajú pôvodné claims.
Súhlas vzniká iba po výslovnom kliknutí a je najviac na180 dní. Aktívne povolenia
sa kontrolujú aj pri každom volaní, takže zúženie alebo deaktivácia pôsobí okamžite.

## Používateľské pripojenie (až po potvrdenom nasadení)

1. V ChatGPT otvoriť **Plugins** a pridanie vlastného MCP servera (tlačidlo **+**).
   Dostupnosť a názvy položiek môžu závisieť od účtu a administrátorských pravidiel.
2. Zadať názov **Nezabudni** a MCP URL uvedenú vyššie.
3. Vybrať OAuth. Pri predregistrovanom klientovi zadať údaje pripravené správcom;
   tajný údaj nevkladať do bežného chatu. Callback musí presne zodpovedať registrácii.
4. Prihlásiť sa účtom Nezabudni a na súhlasovej stránke overiť názov klienta,
   účet a povolenia. Kliknúť **Povoliť pripojenie**.
5. Overiť, že rozhranie načítalo nástroje vyššie. Ak discovery/autentifikácia zlyhá,
   nepovažovať samotné uloženie URL za úspešné pripojenie.
6. V bežnej konverzácii so zapnutým konektorom skúsiť:

   „Skontroluj moje úlohy v Nezabudni.“

7. Priložiť testovací obrázok a skúsiť:

   „Pridaj Dominike na zajtra o 10:00 úlohu Test prílohy a pripoj tento obrázok.“

Pred zápisom potvrdiť názov, príjemcu a termín. Po zápise vyžiadať čítanie úlohy
a overenie ID prílohy. Žiadnu testovaciu úlohu automaticky nemažeme.

Natívny súborový vstup používa `openai/fileParams` podľa oficiálnej dokumentácie.
Nevyžaduje prenos base64 cez model. Server povoľuje iba HTTPS súbory z
`files.oaiusercontent.com`; iné hosty a presmerovania odmieta. Ak host poskytne
inú oficiálnu súborovú doménu, treba ju najprv overiť a pridať cielene, nie povoliť
ľubovoľné URL. Súkromnú download URL nikdy neposielať do PR ani logov.

## Codex a núdzové vypnutie

Codex môže použiť rovnaký MCP endpoint cez OAuth; samostatný OAuth klient má
vlastnú presne zaregistrovanú callback URL. Alternatívne môže autorizovaný lokálny
API klient používať zdokumentované REST API a chránený revokovateľný token.

Pri incidente najskôr deaktivovať konkrétny záznam `integration_clients` a overiť
odmietnutie starého tokenu. Potom podľa potreby deaktivovať OAuth aplikáciu alebo
Edge Function. Nemažte úlohy, používateľov ani migrácie. Databázový rollback
vyžaduje samostatné potvrdenie. ID konkrétneho klienta patrí iba do súkromného
odovzdania, nie do verejného GitHub komentára.

Oficiálne zdroje:
[OpenAI OAuth](https://developers.openai.com/plugins/build/auth),
[natívny file input](https://developers.openai.com/plugins/reference#file-apis),
[Supabase OAuth bezpečnosť](https://supabase.com/docs/guides/auth/oauth-server/token-security).

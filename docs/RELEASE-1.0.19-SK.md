# Nezabudni 1.0.19 — odpoveď na úlohu s celou genézou

Android `1.0.19` / versionCode `20`, web `0.2.16`, databázová schéma `18`.

## Čo sa zmenilo

**Odpoveď na úlohu („↪ Odpovedať“)**
- Keď príjemca úlohu nevie dokončiť a potrebuje z nej úlohu pre niekoho
  iného, klikne na karte svojej aktívnej úlohy **↪ Odpovedať**, napíše,
  čo treba urobiť ďalej, a odošle.
- Formulár predvolí toho, kto úlohu zadal (dá sa vybrať iný člen skupiny,
  nie sebe). Odpoveď je povinná; názov sa predvyplní z pôvodnej úlohy.
  Dá sa pridať príloha, termín, priorita aj „Upozorni ma, keď príjemca
  úlohu splní“.
- Pôvodná úloha sa zavrie ako **„Posunuté → meno“** (záložka Hotové),
  prestane pípať a dá sa odstrániť zo svojho zoznamu. Nová úloha má na
  karte štítok „↪ odpoveď od …“ a príjemca dostane push
  „↪ meno ti posunul/a úlohu“ s textom odpovede.
- V detaile úlohy je sekcia **Genéza úlohy**: všetky kroky reťaze (kto
  komu, kedy, názov, poznámka, prílohy, ako krok skončil). Poznámky sa
  nekopírujú, každý krok si drží svoje. Na odpoveď sa dá znova odpovedať
  (tam a späť), reťaz ostáva jedna.
- Odpovedať sa dá iba na aktívnu úlohu, iba ten, komu je priradená.
  Odpoveď na už splnenú úlohu príde neskôr.
- Opakovaná úloha: odpoveď zavrie len aktuálny výskyt, séria pokračuje
  ako po splnení.
- Funguje aj offline: odpoveď sa uloží do fronty a odošle po pripojení
  (prílohy až online, ako doteraz).

## Nasadenie (v tomto poradí)

1. Supabase: spustiť `supabase/migrations/018_task_handoff.sql`. Pridáva
   stav `handed_off`, stĺpce `parent_task_id`, `thread_id`,
   `handed_off_to`, `handed_off_at` a funkciu `api_handoff_task`.
   Existujúce dáta nemení. Predpokladá nasadenú 017.
2. Push worker: nasadiť `supabase/functions/push-worker` (nový text pushu
   pre posunutú úlohu; číta nové stĺpce, preto až po migrácii).
3. Web (Netlify) — iPhone/PWA sa aktualizuje sám.
4. Android: zostaviť APK lokálne rovnakým debug podpisom ako doterajšie
   vydania a nainštalovať ako aktualizáciu:

   ```
   npm ci
   npm run build
   npx cap sync android
   cd android
   ./gradlew assembleDebug
   ```

Tlačidlo „↪ Odpovedať“ sa ukáže až keď backend hlási schému 18, takže
nová appka pred migráciou nič nepokazí. Staršie verzie appky (1.0.18 a
skôr) novú úlohu z odpovede zobrazia normálne, ale posunutú pôvodnú úlohu
ani genézu nevidia — obaja preto potrebujú 1.0.19 / aktuálny web.

ChatGPT/MCP čítanie úloh vracia aj stav `handed_off`; filter podľa tohto
stavu a genéza v ChatGPT sú na ďalšiu fázu.

## Overenie

- `tests/task-handoff.test.mjs` (PGlite nad reálnymi migráciami):
  atomickosť, oprávnenia (iba príjemca, iba člen skupiny, nie sebe, cudzia
  skupina), povinná odpoveď, idempotentné offline opakovanie, reťaz tam a
  späť, push a zrušené pripomienky, vymazanie, séria „až keď splním“ aj
  „v každom termíne“, práva anon, schéma 18.
- `tests/task-handoff-sync.test.mjs`: offline fronta, sync pri výpadku
  servera nezahodí ani jednu z dvoch úloh, flush uloží obe, filter genézy.
- `tests/task-handoff-ui.test.mjs`: tlačidlo len na mojej aktívnej úlohe a
  len so schémou 18, predvolený príjemca, povinná odpoveď, Hotové /
  Posunuté, genéza v detaile.
- Mutačne overené: 9 z 10 zámerných chýb testy zachytili; desiata (vypnutá
  kontrola prázdnej odpovede vo formulári) je krytá druhou poistkou v
  službe a treťou na serveri.

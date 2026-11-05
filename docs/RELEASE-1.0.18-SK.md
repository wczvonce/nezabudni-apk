# Nezabudni 1.0.18 — údržba: bezpečnosť a spoľahlivé pripomienky

Android `1.0.18` / versionCode `19`, web `0.2.15`, databázová schéma `17`.

## Čo sa zmenilo

**Bezpečnosť (vyžaduje nové APK)**
- Capacitor 8.4.1 → 8.4.3. Oprava kritickej zraniteľnosti WebView
  (GHSA-rvm3-566m-v7fv / CVE-2026-103922, CVSS 9.3): odkaz vo WebView mohol
  cez interný proxy endpoint načítať cudzí obsah s právami aplikácie.
- Opravené závislosti nástrojov (vite, undici, source-map-js) — bezpečnostný
  audit v CI je znova zelený.

**Pripomienky a opakovanie (stačí migrácia 017, funguje aj so starým APK)**
- Opakovanie „v každom termíne“ sa dá zastaviť: vymazanie aktuálneho výskytu
  alebo nastavenie „Opakovanie: žiadne“ sériu ukončí. Predtým server po
  termíne vytvoril ďalší výskyt zo staršieho výskytu.
- Pípanie sa po krátkom výpadku push registrácie obnoví. Keď sa telefón znova
  zaregistruje, čakajúce pripomienky odídu hneď a bez zariadenia sa skúšajú
  každé 2 minúty (predtým 15). V produkcii 27. 10. 2026 séria skončila po
  4 z 10 pípnutí.
- Neprihlásený používateľ už nemôže volať serverové funkcie (obrana do hĺbky,
  funkcie sa aj predtým bránili kontrolou prihlásenia).

**ChatGPT / MCP**
- Zlúčená oprava príloh z regionálnych serverov OpenAI (PR #6). Táto verzia
  funkcie `nezabudni-mcp` už beží v produkcii od 19. 10. 2026.

## Nasadenie

1. Supabase: spustiť `supabase/migrations/017_reminder_reliability.sql`.
   Mení iba definície funkcií a práva, žiadne dáta ani stĺpce. Pred nasadením
   bolo overené, že nahrádzané funkcie sú v živej databáze zhodné s repom.
2. Android: zostaviť APK lokálne rovnakým podpisom ako doterajšie vydania
   a nainštalovať ako aktualizáciu:

   ```
   npm ci
   npm run build
   npx cap sync android
   cd android
   ./gradlew assembleDebug
   ```

   Výsledok: `android/app/build/outputs/apk/debug/app-debug.apk`.
   APK z GitHub CI má iný debug podpis — dá sa nainštalovať iba po
   odinštalovaní pôvodnej appky (úlohy ostávajú na serveri, treba sa znova
   prihlásiť a povoliť notifikácie).

## Overenie

- `npm run audit` (všetky sady vrátane Deno MCP testov) a
  `npm run audit:dependencies` prechádzajú.
- Nový test `tests/reminder-reliability.test.mjs` nad reálnymi migráciami:
  bez 017 zlyhá, s 017 prejde.

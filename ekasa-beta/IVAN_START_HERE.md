# Ivan – ako pokračovať cez Claude Code

## Najjednoduchší postup cez GitHub

1. V Claude Code otvor tento repozitár a vetvu:

```text
repo: wczvonce/nezabudni-apk
branch: ekasa-claude-code-handoff
folder: ekasa-beta
```

2. Spusti Claude Code priamo v priečinku `ekasa-beta`.
3. Vlož tento príkaz:

```text
Prečítaj celý CLAUDE.md a vykonaj ho. Dokonči aplikáciu priamo v súboroch, spusti testy a build a vytvor nové inštalovateľné APK v dist/eKasa-Skener-BETA.apk spolu so SHA-256. Nezostaň pri analýze a neoznač nič za otestované bez skutočného testu.
```

4. Claude má vytvoriť nový APK a GitHub Actions artifact.
5. Výsledok nesmie zostať iba v priečinku `app/build/outputs`; musí byť skopírovaný do:

```text
dist/eKasa-Skener-BETA.apk
```

## Odporúčané finálne usporiadanie

Tento projekt je momentálne vo vetve existujúceho repozitára. Pre dlhodobú prácu je lepšie, aby Claude Code vytvoril nový súkromný repozitár:

```text
wczvonce/ekasa-skener-mobile
```

Dôvodom je čistá história projektu a oddelenie od aplikácie `nezabudni-apk`.

## Dôležitá realita

Aplikácia dokáže naskenovať QR a pokúsiť sa overiť doklad cez službu Over doklad. Použité technické rozhranie však nie je verejne garantované API pre tretie strany. Preto je povinný neoverený chybový stav a odkaz na oficiálnu službu. Claude nesmie predstierať úspešné overenie, ak odpoveď neobsahuje skutočný doklad.

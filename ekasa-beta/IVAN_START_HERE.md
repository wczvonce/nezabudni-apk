# Ivan – spustenie cez Claude Code

## Zdroj projektu

```text
repo: wczvonce/nezabudni-apk
branch: ekasa-claude-code-handoff
folder: ekasa-beta
```

Claude Code spusti priamo v priečinku `ekasa-beta` a vlož mu tento jediný príkaz:

```text
Prečítaj celý CLAUDE.md a vykonaj ho od začiatku do konca. Máš plnú technickú autonómiu: vytvor nový súkromný repozitár wczvonce/ekasa-skener-mobile, prenes doň čistý projekt, oprav alebo prepíš všetko potrebné, reálne preskúmaj aktuálnu integráciu služby Over doklad, spusti testy, zostav a podpíš APK, pri dostupnom ADB ho nainštaluj a oprav chyby z logcat. Nezostaň pri analýze ani pri prvom neúspešnom endpointe. Výsledok musí byť dist/eKasa-Skener-BETA.apk, SHA-256, GitHub Actions artifact a laický návod pre Samsung.
```

Claude má všetky detailné požiadavky v `CLAUDE.md` a kontrolný zoznam v `ACCEPTANCE_CRITERIA.md`.

## Výsledok

Po dokončení má byť nový projekt v:

```text
https://github.com/wczvonce/ekasa-skener-mobile
```

A inštalačný súbor v:

```text
dist/eKasa-Skener-BETA.apk
```

Ak GitHub CLI ešte nie je prihlásený, Claude ťa vyzve iba na oficiálne prihlásenie do GitHubu. Všetky ostatné technické rozhodnutia má urobiť sám.
# Release brána – eKasa Skener BETA

Claude Code smie úlohu označiť za dokončenú až po kontrole týchto bodov.

## Build

- [ ] Gradle Wrapper je súčasťou projektu.
- [ ] Čistý build prešiel.
- [ ] Unit testy prešli.
- [ ] Android lint prešiel alebo jednotlivé výnimky majú konkrétne zdôvodnenie.
- [ ] Vznikol `dist/eKasa-Skener-BETA.apk`.
- [ ] APK je podpísaný minimálne debug podpisom a je inštalovateľný.
- [ ] Vznikol `dist/eKasa-Skener-BETA.apk.sha256`.
- [ ] `versionName` a `versionCode` boli zvýšené.
- [ ] GitHub Actions vytvára rovnaký APK artifact.

## Funkcie

- [ ] Zadná kamera skenuje QR.
- [ ] Zamietnutie povolenia kamery je ošetrené.
- [ ] Kamera sa po zatvorení zastaví.
- [ ] QR z fotografie funguje.
- [ ] Ručný vstup funguje.
- [ ] DEMO funguje bez internetu.
- [ ] História funguje bez internetu.
- [ ] História má maximum 30 záznamov.
- [ ] Duplikát aktualizuje pôvodný záznam.
- [ ] Vyhľadávanie a mazanie histórie funguje.

## Parser

- [ ] Online O-/V- ID má presne 32 hex znakov.
- [ ] ID sa normalizuje na uppercase.
- [ ] Offline QR má presne päť častí.
- [ ] OKP má presný formát 5 × 8 hex.
- [ ] Dátum je reálne validovaný.
- [ ] Číslo dokladu je nezáporné celé číslo.
- [ ] Suma je konečné nezáporné číslo.
- [ ] Cudzie QR sa jasne odmietne.

## Integrácia

- [ ] Online payload používa `receiptId`.
- [ ] Offline payload používa presne `issueDateFormatted`.
- [ ] Endpoint je pevne obmedzený na Over doklad.
- [ ] HTTPS only a cleartext traffic zakázaný.
- [ ] Timeout je nastavený.
- [ ] HTML/WAF odpoveď nie je parsovaná ako doklad.
- [ ] HTTP 200 s aplikačnou chybou nie je úspech.
- [ ] Chýbajúci `receipt` nie je označený ako overený.
- [ ] Pri chybe zostane dostupné ID alebo offline údaje.
- [ ] Odkaz smeruje iba na `https://opd.financnasprava.sk/`.

## Bezpečnosť

- [ ] Všetky kľúče obsahujúce `pkp` sa rekurzívne odstránia.
- [ ] Produkčné logy neobsahujú raw QR ani celý bloček.
- [ ] V repozitári nie je keystore, heslo ani token.
- [ ] Build výstupy a tajomstvá sú v `.gitignore`.
- [ ] História zostáva iba lokálne.
- [ ] Nie je implementované batch alebo enumeračné sťahovanie dokladov.

## Zobrazenie

- [ ] Overený stav sa použije iba pri reálnom úspechu.
- [ ] DEMO je jasne označené.
- [ ] Cena položky sa bez podkladu nezobrazuje dvakrát.
- [ ] DPH podporuje dynamické sadzby a nevymýšľa údaje.
- [ ] Tmavý režim je čitateľný.
- [ ] Ovládacie prvky sú vhodné pre mobil.

## Dokumentácia a dôkazy

- [ ] `README_IVAN.md` vysvetľuje inštaláciu na Samsung.
- [ ] `docs/FINAL_TEST_REPORT.md` uvádza presné príkazy a výsledky.
- [ ] `docs/KNOWN_LIMITATIONS.md` otvorene uvádza negarantované API.
- [ ] Nevykonané testy na fyzickom telefóne alebo živom endpoint-e sú označené ako nevykonané.
- [ ] Záverečná správa obsahuje cestu k APK a jeho SHA-256.

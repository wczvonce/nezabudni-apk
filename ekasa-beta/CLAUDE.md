# Claude Code – dokončenie eKasa Skener BETA

## Cieľ

Prevezmi tento natívny Android projekt a dokonči ho tak, aby vznikol nový priamo inštalovateľný APK pre telefón Samsung. Nezostaň pri audite alebo pláne. Upravuj súbory, spúšťaj testy, opravuj chyby a odovzdaj reálny build.

Povinné výstupy:

```text
dist/eKasa-Skener-BETA.apk
dist/eKasa-Skener-BETA.apk.sha256
```

APK musí byť podpísaný minimálne debug podpisom, aby ho bolo možné priamo nainštalovať. Zvýš `versionName` napríklad na `0.3.0-beta` a zvýš `versionCode`.

## Pravidlá práce

- Najprv skontroluj celý projekt, Git stav, Java, Android SDK a Gradle.
- Nežiadaj používateľa o technické rozhodnutia, ktoré vieš bezpečne urobiť sám.
- Uprednostni funkčný výsledok pred veľkým estetickým prepisom.
- Netvrď, že niečo funguje, ak si príslušný build alebo test nespustil.
- Ak nemáš fyzický telefón alebo reálny QR, označ tieto testy ako manuálne neoverené.
- Necommituj tokeny, heslá, release keystore ani citlivé údaje bločkov.
- Nezapisuj raw QR, PKP ani celý obsah bločka do produkčných logov.
- Žiadne hromadné sťahovanie, enumerovanie ID alebo obchádzanie limitov Finančnej správy.

## Audit existujúceho projektu

Projekt je funkčná referencia, nie hotový produkt. Rozdeľ alebo aspoň oddel testovateľné časti:

- QR parser a validácia,
- tvorba request payloadu,
- API/provider klient,
- normalizácia odpovede,
- rekurzívna sanitizácia PKP,
- história,
- kamera a načítanie fotografie,
- používateľské rozhranie a demo.

Neprepisuj aplikáciu na inú UI technológiu iba kvôli štýlu. Klasické Android Views môžu zostať, ak sú stabilné a čitateľné. Veľmi monolitický kód refaktoruj len natoľko, aby sa dal testovať a bezpečne udržiavať.

## Skenovanie

Musí fungovať:

1. zadná kamera,
2. povolenie aj zamietnutie povolenia,
3. čisté zastavenie kamery,
4. skenovací rám,
5. baterka, ak ju zariadenie podporuje,
6. ochrana pred opakovaným spracovaním rovnakého QR,
7. QR z fotografie alebo screenshotu,
8. ručný vstup,
9. zrozumiteľná chyba pre cudzie QR.

Použi jednu stabilnú skenovaciu knižnicu. Nepridávaj viac paralelných scannerov bez dôvodu.

## Parser

Online ID:

```regex
(?i)([OV]-[0-9A-F]{32})(?![0-9A-F])
```

Môže byť v dlhšom texte alebo URL. Normalizuj ho na uppercase. Neakceptuj ľubovoľný prefix bez dôkazu.

Offline QR má presne päť častí:

```text
OKP:cashRegisterCode:YYMMDDhhmmss:receiptNumber:totalAmount
```

Požiadavky:

- OKP presne 5 skupín × 8 hex znakov a uppercase,
- neprázdny kód pokladnice s rozumným maximom,
- presne 12 číslic dátumu a reálny kalendárny čas,
- nezáporné celé číslo dokladu,
- konečná nezáporná suma,
- formát dátumu pre API `DD.MM.YYYY HH:mm:ss`.

Napíš testy platných aj neplatných hraničných prípadov.

## Over doklad konektor

Pevný endpoint:

```text
POST https://ekasa.financnasprava.sk/mdu/api/v1/opd/receipt/find
```

Nedovoľ všeobecný používateľsky meniteľný proxy/host. HTTPS only, cleartext traffic zakázaný.

Online payload:

```json
{"receiptId":"O-..."}
```

Offline payload:

```json
{
  "okp":"...",
  "cashRegisterCode":"...",
  "issueDateFormatted":"DD.MM.YYYY HH:mm:ss",
  "receiptNumber":123,
  "totalAmount":12.34
}
```

Kľúč musí byť presne `issueDateFormatted`, nie `issueDate`.

Nastav connect/read timeout približne 10–15 sekúnd a hlavičky JSON. Ošetri HTTP 4xx/5xx, timeout, DNS/TLS, HTML/WAF odpoveď, prázdny obsah, neplatný JSON, `returnValue`, `returnCode`, `errorCode`, `errorDescription` a chýbajúci `receipt`.

Doklad označ ako **overený** iba vtedy, keď prišla skutočne úspešná aplikačná odpoveď so skutočným objektom `receipt`. HTTP 200 samo osebe nestačí.

Pri chybe zachovaj naskenované ID alebo lokálne údaje offline QR, ponúkni opakovanie a odkaz iba na:

```text
https://opd.financnasprava.sk/
```

Rozhranie nie je verejne garantované API pre tretie strany. Implementuj provider/adaptér tak, aby sa dal neskôr vymeniť. Neobchádzaj blokáciu ani rate limiting.

## Bezpečnosť

Pred uložením a zobrazením rekurzívne odstráň každý JSON kľúč, ktorého názov obsahuje `pkp` bez ohľadu na veľkosť písmen.

Produkčné logy nesmú obsahovať raw QR, celé ID, OKP, PKP, položky ani kompletnú odpoveď. Na diagnostiku stačí correlation ID, anonymizovaný hash a kategória chyby.

História ostáva lokálne. Nepridávaj analytické SDK ani cloud bez výslovnej požiadavky.

## Detail bločka

Podľa dostupnosti zobraz:

- overený / načítaný-neoverený / DEMO,
- celkovú sumu EUR,
- dátum a čas,
- predajcu a adresu,
- IČO, DIČ, IČ DPH,
- receipt ID, kód pokladnice, OKP, číslo a typ,
- položky, množstvo a jednotku,
- explicitnú jednotkovú cenu,
- celkovú cenu položky,
- sadzbu DPH,
- dynamický súhrn všetkých dostupných sadzieb DPH.

Ak API poskytne iba `price`, zobraz ju iba raz. Nevydávaj ju súčasne za jednotkovú aj celkovú cenu.

Podpor vnorené sumarizačné polia aj ploché legacy polia ako `vatRateBasic`, `taxBaseBasic`, `vatAmountBasic`, `vatRateReduced`, `taxBaseReduced`, `vatAmountReduced` a ďalšie reálne dostupné varianty. Nevymýšľaj chýbajúce hodnoty.

## História a offline režim

- max. 30 záznamov,
- deduplikácia podľa stabilného ID a aktualizácia existujúceho,
- vyhľadávanie podľa predajcu, ID a položky,
- otvorenie detailu,
- zmazanie jedného aj všetkých,
- text „História zostáva iba v tomto telefóne.“

Bez internetu musí fungovať štart, skenovanie, parser, lokálne údaje offline QR, demo, história a mazanie. Online overenie zobrazí jasnú chybu bez pádu.

## Build

Doplň Gradle Wrapper, ak chýba. Použi stabilný Android Gradle Plugin a Java 17 alebo vyžadovanú stabilnú verziu. Nepoužívaj preview SDK, ak nie je potrebné pre sideload APK.

Vytvor:

```text
scripts/build-apk.sh
scripts/build-apk-windows.ps1
scripts/install-apk-windows.ps1
```

Odporúčaný build:

```bash
./gradlew clean test lintDebug assembleDebug
```

Po úspechu skopíruj nový APK do `dist/eKasa-Skener-BETA.apk` a vygeneruj SHA-256. `install-apk-windows.ps1` má pri dostupnom ADB vykonať `adb install -r`; inak vypíše jednoduchý ručný postup.

Release keystore necommituj. Debug APK je akceptovaný ako okamžitý beta inštalačný súbor.

## Testy

Minimálne testuj:

- online parser,
- offline parser a reálny dátum,
- online payload,
- offline payload s presným `issueDateFormatted`,
- cudzie QR,
- HTTP 200 + aplikačná chyba,
- chýbajúci receipt,
- rekurzívne odstránenie PKP,
- položky a DPH,
- max. 30 a deduplikáciu histórie,
- lint,
- čistý APK build.

Živý endpoint test je iba jeden vedomý smoke test s lokálne dodaným receipt ID. Nikdy ho necommituj a nerob batch testy. Ak chýba reálny QR alebo sieť, otvorene to označ ako nevykonané.

## GitHub Actions

Uprav workflow tak, aby pri pushi alebo manuálnom spustení:

- nastavil Java/Android SDK,
- spustil testy a lint,
- zostavil APK,
- pomenoval ho `eKasa-Skener-BETA.apk`,
- vytvoril SHA-256,
- uploadol oba súbory ako artifact,
- pri zlyhaní neuploadol starý build.

## Dokumentácia

Vytvor alebo aktualizuj:

```text
README.md
README_IVAN.md
docs/FINAL_TEST_REPORT.md
docs/KNOWN_LIMITATIONS.md
docs/RELEASE_SIGNING.md
```

`README_IVAN.md` má laicky uviesť inštaláciu na Samsung, povolenie inštalácie z daného zdroja, prvý DEMO test, kameru, význam overený/neoverený a postup pri výpadku služby.

## Koniec úlohy

Neukonči úlohu vetou, že APK „by mal“ fungovať. APK musí reálne vzniknúť. V závere uveď:

- čo si opravil,
- presnú cestu k APK,
- SHA-256,
- príkazy a výsledky testov,
- čo zostalo manuálne overiť na fyzickom telefóne,
- obmedzenie negarantovaného rozhrania Finančnej správy.

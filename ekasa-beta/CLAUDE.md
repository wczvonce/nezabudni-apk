# Claude Code – eKasa Skener Mobile: dokonči funkčný APK

## Mandát

Prevezmi celý projekt a dotiahni ho do reálne fungujúcej Android aplikácie pre Samsung s Androidom 16. Máš plnú technickú autonómiu. Môžeš refaktorovať alebo prepísať problematické časti, zmeniť knižnice či mobilnú architektúru, doplniť backend/proxy, automatizovať verejný tok oficiálnej služby, vytvoriť testy, build pipeline, podpisovanie a GitHub Release.

Neodovzdávaj iba audit, plán ani odporúčania. Pracuj iteratívne: implementuj, spusti, zmeraj výsledok, oprav a znovu otestuj. Pri prvom zlyhaní nehľadaj dôvod skončiť; zisti príčinu a použi ďalšie legitímne technické riešenie. Používateľa zaťaž iba externým prihlásením, fyzickým úkonom alebo údajom, ktorý objektívne nevieš získať sám.

## Nový samostatný repozitár

Cieľový súkromný repozitár je:

```text
wczvonce/ekasa-skener-mobile
```

Ak neexistuje a `gh auth status` funguje, vytvor čistý repozitár a pushni projekt:

```bash
git init
git add .
git commit -m "Initialize eKasa Skener Mobile"
gh repo create wczvonce/ekasa-skener-mobile --private --source=. --remote=origin --push
```

Ak aktuálny adresár obsahuje históriu nesúvisiaceho projektu, vytvor čistý pracovný adresár a prenes iba eKasa zdroje. Ak cieľový názov obsadil nesúvisiaci projekt, použi `wczvonce/ekasa-skener-mobile-app`. APK, build cache, `.env`, signing key a tajomstvá nepatria do Git commitu.

## Povinný výsledok

Úloha je hotová až po vzniku:

```text
dist/eKasa-Skener-BETA.apk
dist/eKasa-Skener-BETA.apk.sha256
README_IVAN.md
docs/FINAL_TEST_REPORT.md
```

APK musí byť reálne zostavený, podpísaný a priamo inštalovateľný. Nastav `versionName` aspoň `0.3.0-beta`, zvýš `versionCode` a zachovaj stabilný application ID, ideálne `sk.povraznik.ekasaskener.beta`.

Ak je dostupný telefón cez ADB, aplikáciu nainštaluj, spusti, sleduj logcat a oprav pády. Inak použi emulátor/instrumentation testy a odovzdaj APK s jednoduchým postupom fyzického testu.

## Mobilné funkcie

Používateľ musí vedieť:

1. naskenovať QR zadnou kamerou,
2. povoliť aj zamietnuť kameru bez pádu,
3. zapnúť baterku, ak ju zariadenie podporuje,
4. načítať QR z fotografie alebo screenshotu,
5. vložiť QR/ID ručne,
6. vidieť lokálne načítané údaje okamžite,
7. online overiť detail dokladu,
8. vidieť predajcu, dátum, sumu, položky a DPH,
9. uložiť a vyhľadať doklad v lokálnej histórii,
10. použiť DEMO a históriu bez internetu.

Kamera sa musí čisto zastaviť a rovnaký QR sa nesmie spracovať opakovane v slučke.

## Parser

Online ID:

```regex
(?i)([OV]-[0-9A-F]{32})(?![0-9A-F])
```

Identifikátor môže byť v dlhšom texte alebo URL. Normalizuj ho na uppercase.

Offline QR:

```text
OKP:cashRegisterCode:YYMMDDhhmmss:receiptNumber:totalAmount
```

Validuj presne päť častí, OKP ako 5 × 8 hex znakov, neprázdny kód pokladnice, reálny 12-ciferný dátum/čas, nezáporné celé číslo dokladu a konečnú nezápornú sumu. Dátum do API formátuj ako `DD.MM.YYYY HH:mm:ss`.

## Reálne eKasa overenie

Známa cesta:

```text
POST https://ekasa.financnasprava.sk/mdu/api/v1/opd/receipt/find
```

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

Offline kľúč je presne `issueDateFormatted`.

Implementuj HTTPS, JSON hlavičky, rozumný User-Agent, timeout a robustné spracovanie HTTP aj aplikačného výsledku. Spracuj `returnValue`, `returnCode`, `errorCode`, `errorDescription`, chýbajúci `receipt`, HTML/WAF odpoveď, timeout, TLS/DNS a zmeny schémy. Stav **Overený** použi iba pri skutočne úspešnej odpovedi s reálnym objektom `receipt`.

### Keď prvý endpoint nefunguje

Pokračuj v riešení:

1. otvor `https://opd.financnasprava.sk/`,
2. pomocou DevTools alebo Playwrightu preskúmaj aktuálny verejný tok jedného ručne zadaného dokladu,
3. zisti aktuálnu URL, payload, cookies/CSRF, hlavičky a formát odpovede,
4. implementuj aktuálne fungujúci provider,
5. ak mobilné priame volanie nie je stabilné, vytvor serverový provider/proxy,
6. ak je potrebný browser session kontext, vytvor Playwright browser adaptér,
7. vytvor provider fallbacky a health-check,
8. vykonaj single-receipt live smoke test s ID dodaným lokálne alebo cez environment variable.

Môžeš použiť Node.js, Cloudflare Worker, serverless funkciu alebo Docker službu – rozhodni podľa reálneho testu. Cieľom je jeden doklad, ktorý používateľ práve naskenoval. Ak automatické online overenie objektívne nie je momentálne dostupné, zachovaj retry a oficiálny odkaz a doplň OCR fotografie ako praktický fallback; OCR jasne označ ako údaje prečítané z fotografie, nie ako eKasa overenie.

## Architektúra

Môžeš zostať pri natívnom Android projekte alebo prejsť na stabilnejšie riešenie. Vyber podľa výsledku buildov a testov. Oddeľ scanner, parser, request model, provider/API klient, normalizáciu, PKP sanitizáciu, históriu, stavovú vrstvu, UI a demo dáta. Monolit rozdeľ vtedy, keď to zlepší testovanie a spoľahlivosť.

## Údaje, história a zobrazenie

Pred uložením a zobrazením rekurzívne odstráň každý JSON kľúč, ktorého názov obsahuje `pkp` bez ohľadu na veľkosť písmen. Produkčné logovanie nastav na anonymizovaný hash/correlation ID a kategóriu chyby.

História zostáva iba lokálne, má maximum 30 dokladov, deduplikáciu a aktualizáciu existujúceho záznamu. Podpor vyhľadávanie podľa predajcu, ID a položky, otvorenie detailu a mazanie jedného aj všetkých záznamov.

Podľa dostupnosti zobraz:

- Overený / Načítaný – neoverený / DEMO,
- predajcu a adresu,
- dátum a čas,
- celkovú sumu EUR,
- IČO, DIČ, IČ DPH,
- ID, kód pokladnice, OKP, číslo a typ,
- položky, množstvo, jednotku,
- explicitnú jednotkovú cenu,
- celkovú cenu položky,
- sadzbu a dynamický súhrn DPH.

Ak je v odpovedi iba `price`, zobraz ju iba raz. Podpor vnorené DPH sumarizácie aj legacy polia ako `vatRateBasic`, `taxBaseBasic`, `vatAmountBasic`, `vatRateReduced`, `taxBaseReduced`, `vatAmountReduced` a ďalšie reálne varianty.

## UI

Vytvor profesionálne mobilné UI pre Samsung: veľké dotykové prvky, safe-area, tmavý režim, bez horizontálneho scrollu. Hlavná obrazovka obsahuje funkčné akcie Naskenovať bloček, Nahrať fotku QR, Zadať ručne, Spustiť ukážku, História a Informácie. Zelený stav patrí iba reálne overenému dokladu.

## Testy

Automatizuj minimálne:

- online/offline parser a hraničné prípady,
- neplatné dátumy a sumy,
- oba request payloady a `issueDateFormatted`,
- cudzie QR,
- HTTP 200 s aplikačnou chybou,
- chýbajúci receipt,
- zmenu schémy,
- rekurzívne odstránenie PKP,
- položky a dynamické DPH,
- max. 30 a deduplikáciu histórie.

Spusti minimálne:

```bash
./gradlew clean test lintDebug assembleDebug
```

Over APK cez `apksigner verify`, `aapt` alebo `apkanalyzer`. Každú chybu oprav a celý relevantný test zopakuj. Skutočné príkazy a výsledky zapíš do `docs/FINAL_TEST_REPORT.md`.

## Build, podpis a inštalácia

Doplň Gradle Wrapper a:

```text
scripts/build-apk.sh
scripts/build-apk-windows.ps1
scripts/install-apk-windows.ps1
```

Vytvor stabilný beta signing postup pre opakovateľné aktualizácie. Keystore drž mimo Git a pre Actions ho ulož cez GitHub Secrets. Výstup skopíruj presne do `dist/eKasa-Skener-BETA.apk` a vytvor SHA-256.

`README_IVAN.md` napíš laicky po slovensky: stiahnutie APK, povolenie inštalácie na Samsungu, DEMO test, kamera, reálny sken, význam stavov a riešenie výpadku online služby.

## GitHub Actions a release

V novom repozitári vytvor workflow pre push, PR a manuálne spustenie: Java/Android SDK, testy, lint, build, kontrola podpisu, pomenovanie APK, SHA-256 a upload artifactu. Po úspešnom finálnom builde vytvor beta tag a GitHub Release s APK, ak máš oprávnenia.

## Záverečné odovzdanie

Uveď URL nového repozitára, branch/commit/tag, zvolenú architektúru, vykonané opravy, aktuálny eKasa provider, výsledok live smoke testu, presnú cestu k APK, SHA-256, výsledky testov/lintu/podpisu a výsledok inštalácie na emulátor alebo telefón.

Neskonči pri pláne ani pri vete „malo by to fungovať“. Pokračuj, kým nevznikne reálny APK a maximálne funkčná verzia overená všetkými dostupnými testami.
# Nezabudni 1.0.16 — opravy upozornení a offline konfliktov

Android: `1.0.16`, versionCode `17`. Web: `0.2.13`.

## Opravy

- Push pripomienka sa v popredí potlačí iba po potvrdení, že aplikácia
  skutočne zobrazila náhradné alarmové okno. Platí to aj pre poslednú
  pripomienku, keď už serverové počítadlo dosiahlo limit.
- Otvorený editor, chýbajúca úloha v cache, chyba UI či predpripomienka
  zachovajú natívne upozornenie. Rozpísaný formulár sa nezatvára.
- Offline synchronizácia porovnáva pôvodnú serverovú verziu, na ktorej
  lokálne úpravy vznikli. Viac lokálnych úprav už nemôže prekryť
  serverové splnenie úlohy. Konfliktné payloady zostávajú vo fronte.
- Kontrola verzie backendu má 5-sekundový limit a ruší sieťový request.
  Výpadok siete sa neoznačuje automaticky ako zastaraná databáza.
- Audit závislostí už na Windows nehlási úspech, keď sa `npm audit`
  vôbec nespustí alebo vráti neúplnú správu. Pribudli regresné testy
  tohto zlyhania a opravené verzie šiestich nepriamych závislostí.

## Overenie 2026-09-22

- Celá sada aplikačných a SQL testov, Deno type-check, kontrola workera,
  Android balíka, dependency audit a web build.
- Android 16 / API 36, x86_64, emulátor Pixel 6 (`Forge_API_36`).
- Dva Android instrumentation testy, bez zlyhania a bez preskočenia.
  Regresný test vykonáva sedem scenárov v skutočnom Android WebView:
  posledná foreground pripomienka, dokončenie cez alarm a IndexedDB,
  zachovanie editovaného konceptu, zachovanie offline zmien pri chybe 500,
  prednosť serverového splnenia, zachovanie dvoch konfliktných zmien,
  časový limit zaseknutého requestu.
- Fixture používa výhradne syntetické účty a mockované serverové odpovede;
  sieťové volania sú vo fixture zablokované. Živé doručenie OneSignal,
  fyzický zvuk a režimy úspory batérie na Samsungu týmto overené nie sú.
- Testovací HTML/JS sa balí iba do samostatnej testovacej APK, nie do
  používateľskej aplikácie. GitHub CI kompiluje instrumentation testy;
  ich vykonanie uvedené vyššie prebehlo lokálne na emulátore.

## Opakovanie Android testu

S Node.js 22+, JDK 21 a spusteným Android emulátorom:

```sh
npm ci
npm run build
npx cap sync android
cd android
./gradlew :app:connectedDebugAndroidTest --no-daemon
```

Na Windows použi `gradlew.bat`. Gradle automaticky vytvorí fixture z
aktuálneho zdrojového kódu. Výsledky sú v
`android/app/build/reports/androidTests/connected/debug/`.
Test vytvára aj screenshoty so syntetickými dátami v externom app files
adresári; Gradle po teste môže aplikáciu odinštalovať a tieto súbory odstrániť.

## Inštalácia a rozsah

Lokálne zostavená APK má rovnaký podpis a applicationId ako vydané APK
1.0.14/1.0.15. Inštalovať ako aktualizáciu, bez odinštalovania a mazania dát.
Samotné číslo verzie na telefóne nepotvrdzuje podpis pôvodnej inštalácie.
GitHub CI používa vlastný debug podpis: jeho APK sa nemá automaticky
považovať za aktualizáciu kompatibilnú s doterajším vydaním.

Táto oprava nemení produkčnú databázu ani nasadené Edge Functions.
Pridávanie ďalších ľudí ešte nie je súčasťou 1.0.16: pred implementáciou
zostáva rozhodnúť, či majú úlohy zostať súkromné medzi zadávateľom a príjemcom,
alebo spoločné pre všetkých členov.

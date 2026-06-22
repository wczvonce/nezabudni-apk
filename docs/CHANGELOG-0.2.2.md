# Nezabudni v19 – zmeny vo verzii 0.2.2

## Kritické opravy

- serializované prechody medzi prihlásením, odhlásením a obnovou relácie,
- ochrana proti tomu, aby stará synchronizácia po prepnutí účtu zapísala dáta do IndexedDB nového účtu,
- kontrola používateľského kontextu po každej asynchrónnej databázovej operácii,
- ochrana proti starým push jobom po snooze, zmene termínu alebo splnení,
- idempotentné spracovanie OneSignal pushu aj pri strate odpovede,
- recovery notifikačných jobov zaseknutých v stave `processing`,
- ochrana pred duplicitným vytvorením/úpravou pri dvojitom kliknutí,
- opravené pokračovanie opakovaných úloh po dlhšom výpadku bez záplavy historických upozornení.

## Offline a synchronizácia

- neplatná offline operácia už neblokuje celý outbox,
- v nastaveniach je viditeľný počet nevyriešených offline zmien,
- nevyriešené zmeny možno znovu skúsiť alebo zahodiť,
- synchronizácia ignoruje neskorú odpoveď predchádzajúceho účtu,
- staré due/repeat joby sa po neskorej registrácii zariadenia už neoživujú.

## Notifikácie

- rate-limit testovacej notifikácie,
- krátka platnosť due/repeat upozornení, aby po návrate online neprišla záplava starých pushov,
- samopriradenie nevytvára zavádzajúcu notifikáciu „od partnera“,
- opakovaný vizuálny alarm v otvorenej aplikácii rešpektuje nastavený interval,
- nový alarmový cyklus po snooze používa verziu úlohy v dedupe kľúči.

## Natívne projekty

- Android `versionCode 3`, `versionName 1.0.2`,
- iOS Push Notifications entitlement a Background Mode `remote-notification`,
- synchronizovaný webový build do Android/iOS projektov.

## Backend upgrade

Ak už bol nasadený starší `001_schema.sql`, spusti:

```text
supabase/migrations/004_deep_audit_fixes.sql
```

Potom znova nasaď `push-worker` a zostav novú APK.

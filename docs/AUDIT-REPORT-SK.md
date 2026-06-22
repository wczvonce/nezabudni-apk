# Technický audit Nezabudni v19 – milestone 1

Dátum auditu: 20. 6. 2026

## Výsledok

Projekt prešiel statickou kontrolou, produkčným webovým buildom, kompiláciou Edge Function a automatizovanými testami nad reálnym PostgreSQL jadrom v pamäti. Počas auditu boli nájdené a opravené chyby, ktoré by pred nasadením mohli spôsobovať duplicitné notifikácie, zlé priradenie zariadenia, zaseknuté offline zmeny alebo nepresné opakovania úloh.

Tento balík je bezpečnejší vývojový základ, ale ešte nie je možné označiť ho za plne produkčne otestovanú mobilnú aplikáciu. End-to-end push treba overiť až po pripojení reálneho Supabase, OneSignal, FCM/APNs a fyzických telefónov.

## Opravené závažné chyby

1. Súbežné spustenie Auth bootstrapu mohlo inicializovať používateľa dvakrát.
2. Manuálne odhlásenie mohlo zrušiť reláciu skôr, než sa telefón odpojil od účtu.
3. Zmena OneSignal subscription sa automaticky nepreregistrovala na backend.
4. Offline mutácie create/update neboli úplne idempotentné.
5. Jedna chybná offline mutácia mohla zablokovať celý outbox.
6. Notifikácia „nová úloha od partnera“ sa po vytvorení úlohy omylom okamžite rušila.
7. Po odložení alebo návrate času na pôvodnú hodnotu mohol starý dedupe kľúč zablokovať nový alarmový cyklus.
8. Push job v stave `processing` mohol po páde workera zostať zamknutý navždy.
9. Job bez aktívnej subscription sa vzdal príliš skoro.
10. OneSignal odpoveď bez message ID mohla byť považovaná za úspech.
11. Zmeškaná predpripomienka sa mohla odoslať súčasne s riadnou pripomienkou.
12. Tlačidlo „Otvoriť úlohu“ v alarmovom okne stratilo referenciu na úlohu.
13. Rovnaká úloha sa po odložení nemusela zobraziť ako nový alarmový cyklus.
14. Denné a týždenné opakovanie mohlo meniť miestny čas pri prechode na letný/zimný čas.
15. Mesačné opakovanie od 31. dňa mohlo driftovať na 28. deň aj v ďalších mesiacoch.
16. Realtime publikácia tabuľky `tasks` nebola v migrácii výslovne zapnutá.
17. Zlyhanie prílohy mohlo vyzerať ako zlyhanie celej už uloženej úlohy.
18. iOS projekt nemal pripravený Push Notifications entitlement.
19. iOS projekt nemal pripravený Background Mode `remote-notification`.
20. Súbežné refresh/sync požiadavky mohli prepísať novší lokálny stav staršou odpoveďou.
21. Retry OneSignal požiadavky nemal stabilný `idempotency_key`, takže timeout po prijatí správy mohol vytvoriť duplicitný push.
22. Starý súbežný worker mohol po úspechu novšieho workera zmeniť job späť na failed/queued alebo druhýkrát zvýšiť počítadlo pripomienok.
23. Dlhé TTL mohlo po návrate telefónu online doručiť naraz sériu starých opakovaných pripomienok; reminder pushy teraz používajú krátke dynamické TTL.
24. Neplatné časové pásmo mohlo rozbiť generovanie opakovaných úloh a zablokovať celý worker; vstup sa teraz validuje a chyba recurrence už nezastaví ostatné push joby.
25. Neplatné alebo prázdne subscription ID sa mohlo uložiť ako zariadenie; backend ho teraz odmietne.

## Pridané automatizované testy

- kompletné vykonanie SQL migrácie,
- vytvorenie a idempotentné zopakovanie úlohy,
- úprava a preplánovanie upozornenia,
- odloženie a nový reminder cyklus,
- splnenie a jediné potvrdenie autorovi,
- ochrana vlastníctva push subscription,
- bezpečný prevod neaktívnej subscription,
- DST a mesačné opakovanie,
- generovanie opakovaných výskytov,
- zotavenie stale worker locku,
- ochrana sent jobu pred neskorým failed/sent callbackom,
- odmietnutie neplatného časového pásma a subscription ID,
- kontrola krátkeho TTL pre opakované reminder pushy,
- oddelenie IndexedDB podľa používateľského UUID,
- otvorenie detailu z alarmového modalu,
- nový alarmový cyklus po snooze,
- statická kontrola worker idempotency a timeoutu,
- kompilácia Supabase Edge Function cez esbuild.

## Príkaz na kompletnú lokálnu kontrolu

```bash
npm ci
npm run audit
npx cap sync android
npx cap sync ios
npm audit
```

## Čo sa nedalo overiť v tomto prostredí

- reálne doručenie APNs pushu na iPhone,
- reálne doručenie FCM pushu na Android,
- prihlásenie proti tvojmu budúcemu Supabase projektu,
- reálny Supabase Cron a Edge Function deployment,
- iOS podpisovanie a TestFlight build, pretože nie je dostupný Mac/Xcode,
- Android APK build, pretože prostredie nedokázalo stiahnuť Gradle z `services.gradle.org`.

## Známe nedokončené funkcie

- Google Calendar synchronizácia je zámerne vypnutá,
- zoznam/otváranie/mazanie už nahratých príloh ešte nie je dokončené,
- natívne lokálne offline alarmy nie sú zapojené,
- konfliktné offline mutácie sa označia ako failed a zobrazí sa chyba, ale zatiaľ nemajú používateľskú obrazovku na ručné vyriešenie,
- OneSignal Notification Service Extension a App Group sa musia dokončiť v Xcode pri prvom iOS nasadení.

# Nezabudni 1.0.17 — ďalší členovia spoločnej skupiny

Android `1.0.17` / versionCode `18`, web `0.2.14`.

## Zdieľanie a používanie

Používateľ potvrdil spoločnú viditeľnosť: nový člen vidí všetky úlohy
existujúcej skupiny, vrátane starších úloh a príloh. Nemeníme existujúce
práva na dokončenie úlohy: dokončuje ju príjemca. Termínové upozornenie
ide príjemcovi; voliteľné upozornenie po splnení ide autorovi.

1. Vlastník otvorí Nastavenia → Ľudia — pridať človeka / obnoviť členov.
2. Zadá e-mail pozvaného človeka a výslovne potvrdí zdieľanie všetkých úloh.
3. Vytvorený kód pošle súkromne tomuto človeku. Aplikácia neposiela
   automatický e-mail s pozvánkou. Kód sa ukáže iba do zatvorenia okna.
4. Nový človek si v prihlasovacej obrazovke vytvorí vlastný účet s rovnakým
   e-mailom. Potvrdí e-mail zo Supabase a prihlási sa.
5. Zadá meno a kód, potvrdí spoločnú viditeľnosť a prijme pozvánku.
6. Existujúci členovia použijú „Obnoviť členov a pozvánky“ alebo znova
   spustia aplikáciu. Nový človek pribudne vo výbere príjemcu a má vlastnú
   záložku vedľa ostatných členov. „Všetky“ zobrazuje spoločné úlohy.

Iba vlastník môže pozývať. Pozvánka je jednorazová, viazaná na overený e-mail,
platí 7 dní a možno ju zrušiť pred prijatím. Databáza uchováva iba SHA-256
hash 256-bitového náhodného kódu. Limit: 20 členov, 10 súčasne aktívnych
pozvánok a 20 vytvorených pozvánok za 24 hodín na skupinu. Stratený kód sa
neobnovuje: vlastník starú pozvánku zruší a vytvorí novú. Zrušenie pozvánky
neodoberá už prijatého člena. Mazanie/odoberanie členov nie je súčasťou tejto verzie.

## Kompatibilita a nasadenie — vyžaduje osobitné potvrdenie

- Nová migrácia `013_group_invitations.sql` pridáva izolované tabuľky a RPC,
  zvyšuje schema_version na 13. Nemení stĺpce tasks, pôvodné api_create_task,
  notifikačnú frontu ani push-worker. Existujúce dáta sa nemažú.
- Pred nasadením: potvrdiť správny Supabase projekt, vytvoriť GitHub checkpoint,
  zálohovať DB mimo GitHubu, overiť históriu migrácií a dry-run iba migrácie 013.
- Pred povolením tretieho člena nasadiť aj aktualizovanú `chatgpt-api`.
  Tá je spätne kompatibilná s dvojicou aj pred migráciou. Migrácia zachytí
  pôvodného partnera oboch členov; význam `self` / `partner` sa nezmení.
  ChatGPT Action zatiaľ nevytvára úlohy pre ľubovoľného nového člena — to
  je možné cez výber príjemcu v aplikácii. Pri chýbajúcom mapovaní Action
  bezpečne odmietne požiadavku, nikdy náhodne nevyberie člena.
- Supabase musí povoľovať registráciu cez e-mail a doručovať potvrdzovacie
  e-maily. To treba overiť na potvrdenom projekte; aplikácia nevypína
  overovanie e-mailov a neuchováva cudzie heslá.
- Bez migrácie ostávajú pôvodné úlohy použiteľné, ale pozvánky hlásia,
  že funkcia ešte nie je nasadená. Neinzerovať nový onboarding ako živý,
  kým neprejde overenie na reálnom projekte.
- Vydávať APK podpísanú rovnakým kľúčom ako predchádzajúce vydanie.
  CI debug APK používa iný debug podpis, nie je automaticky vhodná na upgrade.

## Automatizované overenie

`npm run audit` zahŕňa pôvodné regresie aj `npm run test:groups`.
SQL testy vykonávajú migrácie v PGlite: oprávnenia, potvrdenie zdieľania,
overený e-mail, expirácia, nesprávny kód, zrušenie, idempotentné prijatie,
zachovanie pôvodného partnera, RLS viditeľnosť starších úloh, pridelenie
tretiemu členovi a jedno upozornenie autora pri opakovanom dokončení.

Android instrumentation (`:app:connectedDebugAndroidTest`) vykonáva
15 scenárov: pôvodných 7 regresií a 8 nových skupinových scenárov vrátane
formulára pozvánky, registrácie/prijatia s ochranou dvojkliku, hashovania, skrytia kódu, výberu príjemcu, záložiek a
uloženia úlohy pre tretieho člena s upozornením autora. Ide o skutočný
Android WebView a IndexedDB, ale syntetické účty a mockovaný backend.
Živá registrácia, potvrdzovací e-mail, cloudová pozvánka a doručenie push
na fyzický telefón zostávajú samostatným testom po schválenom nasadení.

## Núdzové zastavenie pozvánok

Po samostatnom schválení môže správca zastaviť nové pozvania a prijímanie:

```sql
revoke execute on function public.create_group_invitation(text,text,boolean) from authenticated;
revoke execute on function public.accept_group_invitation(text,text,boolean) from authenticated;
```

Tým sa nemenia existujúce členstvá ani úlohy. Migráciu ani databázu
automaticky nevracať; odoberanie už udeleného prístupu vyžaduje samostatný plán.

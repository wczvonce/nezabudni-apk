# Nezabudni 1.0.20 — oprava budíka pri veľmi dlhej úlohe

Android `1.0.20` / versionCode `21`, web `0.2.17`, databázová schéma `18` (bez zmeny).

## Čo sa zmenilo

**Budík s dlhou úlohou sa dá zavrieť**
- Pri úlohe s veľmi dlhou poznámkou (napr. zadanie s viacerými bodmi) sa okno
  budíka nezmestilo na obrazovku: tlačidlá OK / Odložiť / Hotovo / Otvoriť
  úlohu boli mimo obrazovky, plocha sa nedala posúvať a z budíka sa nedalo
  odísť. Najviac pri väčšom písme v telefóne.
- Teraz sa okno vždy zmestí na obrazovku (aj nad systémové lišty Androidu),
  názov a poznámka sa posúvajú vo vlastnej oblasti a tlačidlá ostávajú vždy
  viditeľné. Dlhá poznámka je zarovnaná doľava, dlhý názov je menší.
- V detaile úlohy pole s poznámkou rastie s textom (najviac do 45 % výšky
  obrazovky), takže dlhá poznámka sa dá čítať aj pri hotovej úlohe.

**Detail úlohy a genéza (nájdené v emulátore)**
- Detail sa vždy otvorí od vrchu. Pri existujúcej úlohe už appka neskočí na
  pole s názvom (to odrolovalo genézu mimo obrazovky a otváralo klávesnicu);
  fokus ostáva len pri novej úlohe.
- Dlhá poznámka v kroku genézy je skrátená na 5 riadkov s „zobraziť celé ▾“,
  ťuknutím sa rozbalí aj zbalí.
- Po uložení alebo odoslaní sa zruší fokus v poli, aby na telefóne neostala
  otvorená klávesnica.

## Nasadenie

1. Web (Netlify) — iPhone/PWA sa aktualizuje sám.
2. Android: APK lokálne rovnakým debug podpisom, inštalácia ako aktualizácia.

Databáza ani push-worker sa nemenia.

## Overenie

- Android emulátor (Pixel 6, Android 16): inštrumentované testy v skutočnom
  Android WebView, 19 scenárov vrátane dlhej úlohy v budíku (všetky tlačidlá
  na obrazovke, text sa posúva, „Otvoriť úlohu“ budík zavrie) a odpovede na
  úlohu; pri bežnom aj zväčšenom písme (1,3×). Snímky obrazovky z emulátora.
- Aktualizácia 1.0.19 → 1.0.20 v emulátore bez odinštalovania.
- `npm run audit` (lokálne bez Deno krokov, celé v CI).

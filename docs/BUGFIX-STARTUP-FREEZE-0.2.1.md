# Oprava zamrznutia pri štarte – v0.2.1

## Symptóm
Android aplikácia zostala na obrazovke „Spúšťam Nezabudni…“ a nezobrazila prihlasovanie ani hlavnú obrazovku.

## Príčina
`onAuthStateChange` používal asynchrónny callback, ktorý pri existujúcej Supabase relácii spúšťal ďalšie Supabase dotazy. Callback sa vykonáva počas internej auth operácie a mohol vytvoriť deadlock. Súbežné `getSession()` potom čakalo bez ukončenia.

## Oprava
- auth callback je okamžite synchronný,
- asynchrónna obsluha sa odkladá cez `setTimeout(..., 0)`,
- `getSession`, `signIn` a `signOut` majú timeout,
- pridaný regresný test `tests/auth-deadlock.test.mjs`,
- webové súbory boli znovu zostavené a synchronizované do Android projektu.

## Po inštalácii opravenej APK
Odporúča sa pôvodnú testovaciu APK odinštalovať alebo vymazať jej dáta, potom nainštalovať nový build. Tým sa odstráni prípadná stará alebo poškodená auth relácia.

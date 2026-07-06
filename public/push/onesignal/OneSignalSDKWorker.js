// OneSignal web push service worker (PWA push pre iPhone/desktop bez natívnej appky).
// Beží v scope /push/onesignal/, aby nekolidoval s aplikačným /sw.js (offline cache).
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

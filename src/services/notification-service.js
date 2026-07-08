import OneSignal, { LogLevel } from '@onesignal/capacitor-plugin';
import { platform, platformLabel } from '../lib/platform.js';
import { CONFIG } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { singleFlight } from '../lib/async.js';

let initialized = false;
let currentSubscriptionId = null;
let clickHandler = null;
// Web SDK handle (OneSignal Web SDK v16). Natívna vetva používa Capacitor plugin.
let webSdk = null;
// Počas odhlasovania nesmie subscription-change event zariadenie znova
// aktivovať (api_register_device) – odhlásený telefón by ďalej dostával pushe.
let registrationSuspended = false;

export function suspendDeviceRegistration() { registrationSuspended = true; }

// Web push (PWA): od iOS 16.4 fungujú push notifikácie aj bez natívnej appky,
// ale iba ak je appka pridaná na ploche a otvorená z plochy (standalone režim) –
// v obyčajnej Safari karte na iOS `Notification` vôbec neexistuje.
function isIOSBrowser() { return /iPad|iPhone|iPod/.test(navigator.userAgent || ''); }
function isStandalone() { return window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator?.standalone === true; }
export function webPushSupported() {
  return platform.isWeb && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}
function pushCapable() { return platform.isNative || webPushSupported(); }

function webPushUnsupportedReason() {
  if (isIOSBrowser() && !isStandalone()) {
    return 'Na iPhone najprv pridaj appku na plochu (Safari → Zdieľať → Pridať na plochu) a otvor ju z plochy.';
  }
  return 'Tento prehliadač nepodporuje push notifikácie.';
}

// Stabilné referencie listenerov – aby sa registrovali práve raz (Issue 10).
// Tvary eventov sú kompatibilné medzi Capacitor pluginom a Web SDK v16
// (notification.additionalData, event.current.id, event.preventDefault).
function handleNotificationClick(event) {
  const data = event?.notification?.additionalData || {};
  clickHandler?.({ taskId: data.task_id || null, action: event?.result?.actionId || 'open', kind: data.kind || null });
}

function handleSubscriptionChange(event) {
  currentSubscriptionId = event?.current?.id || null;
  if (registrationSuspended) return;
  if (currentSubscriptionId && supabase) {
    registerCurrentDevice().catch((error) => console.warn('Push subscription re-registration failed', error));
  }
}

// Issue 8: keď je appka v popredí, NEZOBRAZUJ natívnu notifikáciu – appka má
// vlastné in-app upozornenie (alarm/modal). Tak sa nezobrazia dve naraz.
// V pozadí/zatvorená sa foregroundWillDisplay nespustí, takže natívny push funguje.
function handleForegroundWillDisplay(event) {
  event?.preventDefault?.();
  const notification = event?.getNotification?.() ?? event?.notification;
  const data = notification?.additionalData || {};
  if (data.task_id) clickHandler?.({ taskId: data.task_id, action: 'foreground', kind: data.kind || null });
}

// Web SDK sa načítava z CDN až keď je potrebné (na natívnej platforme nikdy).
function loadWebSdk() {
  return new Promise((resolve, reject) => {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push((sdk) => resolve(sdk));
    if (document.querySelector('script[data-onesignal-sdk]')) return;
    const script = document.createElement('script');
    script.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
    script.defer = true;
    script.dataset.onesignalSdk = 'true';
    script.onerror = () => {
      // Chybný tag treba odstrániť — inak by ho ďalší pokus našiel cez
      // querySelector, nič by nepridal a Promise by visela naveky
      // (zamrznuté tlačidlá v Nastaveniach vrátane odhlásenia).
      script.remove();
      reject(new Error('OneSignal SDK sa nepodarilo načítať. Skontroluj internet.'));
    };
    document.head.appendChild(script);
  });
}

// Single-flight inicializácia: súbežní volajúci čakajú na ten istý beh,
// listenery sa registrujú raz, neúspešný beh je znova spustiteľný (Issue 10).
const ensureInitialized = singleFlight(async () => {
  if (platform.isNative) {
    if (import.meta.env.DEV) OneSignal.Debug.setLogLevel(LogLevel.Verbose);
    await OneSignal.initialize(CONFIG.oneSignalAppId);
    OneSignal.Notifications.addEventListener('click', handleNotificationClick);
    OneSignal.Notifications.addEventListener('foregroundWillDisplay', handleForegroundWillDisplay);
    OneSignal.User.pushSubscription.addEventListener('change', handleSubscriptionChange);
  } else {
    webSdk = await loadWebSdk();
    await webSdk.init({
      appId: CONFIG.oneSignalAppId,
      // Vlastný scope, aby OneSignal worker nekolidoval s aplikačným /sw.js.
      serviceWorkerPath: 'push/onesignal/OneSignalSDKWorker.js',
      serviceWorkerParam: { scope: '/push/onesignal/' },
    });
    webSdk.Notifications.addEventListener('click', handleNotificationClick);
    webSdk.Notifications.addEventListener('foregroundWillDisplay', handleForegroundWillDisplay);
    webSdk.User.PushSubscription.addEventListener('change', handleSubscriptionChange);
  }
  initialized = true;
});

async function getSubscriptionId() {
  if (!initialized) return currentSubscriptionId;
  if (platform.isNative) return OneSignal.User.pushSubscription.getIdAsync();
  return webSdk?.User?.PushSubscription?.id ?? null;
}

function deviceInstallId() {
  const key = 'nezabudni-v19-device-install-id';
  let value = localStorage.getItem(key);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(key, value); }
  return value;
}

export async function initializeNotifications(onNotificationClick) {
  clickHandler = onNotificationClick;
  // Nové prihlásenie ruší suspend z predchádzajúceho odhlásenia.
  registrationSuspended = false;
  if (!pushCapable() || !CONFIG.oneSignalAppId) {
    return diagnostics();
  }
  await ensureInitialized();
  currentSubscriptionId = await getSubscriptionId();
  return diagnostics();
}

export async function requestNotificationPermission() {
  if (!CONFIG.oneSignalAppId) throw new Error('Chýba OneSignal App ID.');
  if (!pushCapable()) throw new Error(webPushUnsupportedReason());
  if (!initialized) await initializeNotifications(clickHandler);
  let accepted;
  if (platform.isNative) {
    accepted = await OneSignal.Notifications.requestPermission(true);
  } else {
    // optIn() vyžiada povolenie prehliadača a vytvorí push subscription.
    // Musí bežať z kliknutia používateľa (iOS PWA to vyžaduje) – volá sa
    // z tlačidla „Zapnúť upozornenia".
    await webSdk.User.PushSubscription.optIn();
    accepted = webSdk.Notifications.permission === true || Notification.permission === 'granted';
  }
  currentSubscriptionId = await waitForSubscription();
  return { accepted, subscriptionId: currentSubscriptionId };
}

async function waitForSubscription() {
  for (let i = 0; i < 20; i += 1) {
    const id = await getSubscriptionId();
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

export async function registerCurrentDevice() {
  if (!supabase || !pushCapable()) return diagnostics();
  if (!initialized) await initializeNotifications(clickHandler);
  currentSubscriptionId = await getSubscriptionId();
  if (!currentSubscriptionId) return diagnostics();
  const { error } = await supabase.rpc('api_register_device', {
    p_subscription_id: currentSubscriptionId,
    p_platform: platform.name,
    p_device_install_id: deviceInstallId(),
    p_device_name: platformLabel(),
  });
  if (error) throw error;
  return diagnostics();
}

export async function unregisterCurrentDevice() {
  if (!supabase || !pushCapable()) return;
  if (!currentSubscriptionId && initialized) currentSubscriptionId = await getSubscriptionId();
  if (!currentSubscriptionId) return;
  const { error } = await supabase.rpc('api_unregister_device', { p_subscription_id: currentSubscriptionId });
  if (error) throw error;
  currentSubscriptionId = null;
}

// Núdzový fallback pri odhlásení: keď OneSignal inicializácia zlyhala,
// subscription_id nepoznáme — ale device_install_id (localStorage) máme vždy.
// Server deaktivuje VŠETKY subscriptions tohto zariadenia, inak by odhlásený
// telefón ďalej dostával pushe používateľa.
export async function unregisterCurrentInstall() {
  if (!supabase) return;
  const { error } = await supabase.rpc('api_unregister_install', { p_device_install_id: deviceInstallId() });
  if (error) throw error;
}

export async function sendTestNotification() {
  if (!supabase) throw new Error('Cloud nie je nakonfigurovaný.');
  const { data, error } = await supabase.rpc('api_send_test_notification');
  if (error) throw error;
  return data;
}

export async function diagnostics() {
  let permission = platform.isNative || webPushSupported() ? 'nezistené' : webPushUnsupportedReason();
  let optedIn = false;
  if (initialized) {
    if (platform.isNative) {
      permission = (await OneSignal.Notifications.hasPermission()) ? 'povolené' : 'nepovolené';
      optedIn = await OneSignal.User.pushSubscription.getOptedInAsync();
    } else if (webSdk) {
      permission = Notification.permission === 'granted' ? 'povolené' : Notification.permission === 'denied' ? 'zamietnuté' : 'nevyžiadané';
      optedIn = webSdk.User.PushSubscription.optedIn === true;
    }
    currentSubscriptionId = await getSubscriptionId();
  }
  return {
    platform: platformLabel(),
    native: platform.isNative,
    webPush: !platform.isNative && webPushSupported(),
    configured: Boolean(CONFIG.oneSignalAppId),
    permission,
    optedIn,
    subscriptionId: currentSubscriptionId,
  };
}

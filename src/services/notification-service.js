import OneSignal, { LogLevel } from '@onesignal/capacitor-plugin';
import { platform, platformLabel } from '../lib/platform.js';
import { CONFIG } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { singleFlight } from '../lib/async.js';

let initialized = false;
let currentSubscriptionId = null;
let clickHandler = null;

// Stabilné referencie listenerov – aby sa registrovali práve raz (Issue 10).
function handleNotificationClick(event) {
  const data = event?.notification?.additionalData || {};
  clickHandler?.({ taskId: data.task_id || null, action: event?.result?.actionId || 'open' });
}

function handleSubscriptionChange(event) {
  currentSubscriptionId = event?.current?.id || null;
  if (currentSubscriptionId && supabase) {
    registerCurrentDevice().catch((error) => console.warn('Push subscription re-registration failed', error));
  }
}

// Single-flight inicializácia: súbežní volajúci čakajú na ten istý beh,
// listenery sa registrujú raz, neúspešný beh je znova spustiteľný (Issue 10).
const ensureInitialized = singleFlight(async () => {
  if (import.meta.env.DEV) OneSignal.Debug.setLogLevel(LogLevel.Verbose);
  await OneSignal.initialize(CONFIG.oneSignalAppId);
  OneSignal.Notifications.addEventListener('click', handleNotificationClick);
  OneSignal.User.pushSubscription.addEventListener('change', handleSubscriptionChange);
  initialized = true;
});

function deviceInstallId() {
  const key = 'nezabudni-v19-device-install-id';
  let value = localStorage.getItem(key);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(key, value); }
  return value;
}

export async function initializeNotifications(onNotificationClick) {
  clickHandler = onNotificationClick;
  if (!platform.isNative || !CONFIG.oneSignalAppId) {
    return diagnostics();
  }
  await ensureInitialized();
  currentSubscriptionId = await OneSignal.User.pushSubscription.getIdAsync();
  return diagnostics();
}

export async function requestNotificationPermission() {
  if (!platform.isNative) throw new Error('Natívne push notifikácie sa testujú v Android/iPhone aplikácii.');
  if (!CONFIG.oneSignalAppId) throw new Error('Chýba OneSignal App ID.');
  if (!initialized) await initializeNotifications(clickHandler);
  const accepted = await OneSignal.Notifications.requestPermission(true);
  currentSubscriptionId = await waitForSubscription();
  return { accepted, subscriptionId: currentSubscriptionId };
}

async function waitForSubscription() {
  for (let i = 0; i < 20; i += 1) {
    const id = await OneSignal.User.pushSubscription.getIdAsync();
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

export async function registerCurrentDevice() {
  if (!supabase || !platform.isNative) return diagnostics();
  if (!initialized) await initializeNotifications(clickHandler);
  currentSubscriptionId = await OneSignal.User.pushSubscription.getIdAsync();
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
  if (!supabase || !platform.isNative) return;
  if (!currentSubscriptionId && initialized) currentSubscriptionId = await OneSignal.User.pushSubscription.getIdAsync();
  if (!currentSubscriptionId) return;
  const { error } = await supabase.rpc('api_unregister_device', { p_subscription_id: currentSubscriptionId });
  if (error) throw error;
  currentSubscriptionId = null;
}

export async function sendTestNotification() {
  if (!supabase) throw new Error('Cloud nie je nakonfigurovaný.');
  const { data, error } = await supabase.rpc('api_send_test_notification');
  if (error) throw error;
  return data;
}

export async function diagnostics() {
  let permission = 'nepodporované vo webovom náhľade';
  let optedIn = false;
  if (platform.isNative && initialized) {
    permission = (await OneSignal.Notifications.hasPermission()) ? 'povolené' : 'nepovolené';
    optedIn = await OneSignal.User.pushSubscription.getOptedInAsync();
    currentSubscriptionId = await OneSignal.User.pushSubscription.getIdAsync();
  }
  return {
    platform: platformLabel(),
    native: platform.isNative,
    configured: Boolean(CONFIG.oneSignalAppId),
    permission,
    optedIn,
    subscriptionId: currentSubscriptionId,
  };
}

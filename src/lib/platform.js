import { Capacitor } from '@capacitor/core';

export const platform = {
  isNative: Capacitor.isNativePlatform(),
  name: Capacitor.getPlatform(),
  isIOS: Capacitor.getPlatform() === 'ios',
  isAndroid: Capacitor.getPlatform() === 'android',
  isWeb: Capacitor.getPlatform() === 'web',
};

export function platformLabel() {
  if (platform.isIOS) return 'iPhone / iOS';
  if (platform.isAndroid) return 'Android';
  return 'Webová testovacia verzia';
}

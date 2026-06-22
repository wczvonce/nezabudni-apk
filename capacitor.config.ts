import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'sk.povraznik.nezabudni.test',
  appName: 'NezabudniTest',
  webDir: 'dist',
  bundledWebRuntime: false,
  ios: {
    handleApplicationNotifications: false,
    contentInset: 'automatic',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;

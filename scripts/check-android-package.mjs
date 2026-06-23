// Issue 13: jediný zdroj pravdy pre Android package/applicationId.
// Odvodí package z build.gradle a overí, že namespace a capacitor.config.ts
// sa zhodujú. Žiadne natvrdo zapísané meno balíka v testoch/CI/skriptoch.
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');

const gradle = read('android/app/build.gradle');
const cap = read('capacitor.config.ts');

const applicationId = gradle.match(/applicationId\s+["']([^"']+)["']/)?.[1] || null;
const namespace = gradle.match(/namespace\s*=\s*["']([^"']+)["']/)?.[1] || null;
const capAppId = cap.match(/appId:\s*['"]([^'"]+)['"]/)?.[1] || null;

const errors = [];
if (!applicationId) errors.push('android/app/build.gradle: applicationId sa nenašiel');
if (!namespace) errors.push('android/app/build.gradle: namespace sa nenašiel');
if (!capAppId) errors.push('capacitor.config.ts: appId sa nenašiel');
if (applicationId && namespace && applicationId !== namespace) {
  errors.push(`applicationId (${applicationId}) != namespace (${namespace})`);
}
if (applicationId && capAppId && applicationId !== capAppId) {
  errors.push(`applicationId (${applicationId}) != capacitor appId (${capAppId})`);
}

export function resolveAndroidPackage() {
  if (errors.length) throw new Error('ANDROID PACKAGE CHECK FAILED:\n - ' + errors.join('\n - '));
  return { applicationId, namespace, capAppId };
}

// Spustenie ako skript.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-android-package.mjs')) {
  if (errors.length) {
    console.error('ANDROID PACKAGE CHECK FAILED:');
    for (const e of errors) console.error(' - ' + e);
    process.exit(1);
  }
  console.log(`ANDROID PACKAGE OK: ${applicationId}`);
}

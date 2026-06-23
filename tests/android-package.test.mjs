import assert from 'node:assert/strict';
import fs from 'node:fs';

// Issue 13: package sa ODVODZUJE z konfigurácie, nie je natvrdo zapísaný.
const root = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');

const gradle = read('android/app/build.gradle');
const capacitorGradle = read('android/app/capacitor.build.gradle');
const cap = read('capacitor.config.ts');
const workflow = read('.github/workflows/ci.yml');

const applicationId = gradle.match(/applicationId\s+["']([^"']+)["']/)?.[1];
const namespace = gradle.match(/namespace\s*=\s*["']([^"']+)["']/)?.[1];
const capAppId = cap.match(/appId:\s*['"]([^'"]+)['"]/)?.[1];

assert.ok(applicationId, 'build.gradle musí mať applicationId');
assert.ok(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(applicationId), `neplatný applicationId: ${applicationId}`);

// Konfigurácie sa musia zhodovať – inak jasné zlyhanie (jeden zdroj pravdy).
assert.equal(namespace, applicationId, 'namespace sa musí zhodovať s applicationId');
assert.equal(capAppId, applicationId, 'capacitor appId sa musí zhodovať s applicationId');

// CI Java musí zodpovedať Java verzii vygenerovanej Capacitorom.
const sourceJava = capacitorGradle.match(/sourceCompatibility\s+JavaVersion\.VERSION_(\d+)/)?.[1];
const targetJava = capacitorGradle.match(/targetCompatibility\s+JavaVersion\.VERSION_(\d+)/)?.[1];
const workflowJava = workflow.match(/java-version:\s*['"]?(\d+)/)?.[1];
assert.ok(sourceJava, 'capacitor.build.gradle musí definovať sourceCompatibility');
assert.equal(targetJava, sourceJava, 'sourceCompatibility a targetCompatibility sa musia zhodovať');
assert.equal(workflowJava, sourceJava, `CI musí používať Java ${sourceJava}, nie Java ${workflowJava || 'nezistená'}`);

// CI musí nainštalovať platformu zhodnú s compileSdkVersion.
const compileSdk = read('android/variables.gradle').match(/compileSdkVersion\s*=\s*(\d+)/)?.[1];
assert.ok(compileSdk, 'variables.gradle musí definovať compileSdkVersion');
assert.match(workflow, new RegExp(`platforms;android-${compileSdk}`), `CI musí nainštalovať Android SDK ${compileSdk}`);

// Žiadny iný/zastaraný sk.povraznik.* package názov v testoch/skriptoch/CI.
const scan = (rel) => { try { return read(rel); } catch { return ''; } };
const sources = [
  scan('scripts/check-android-package.mjs'),
  scan('scripts/validate.mjs'),
  workflow,
].join('\n');
const foreign = [...sources.matchAll(/sk\.povraznik\.[a-z0-9_.]+/g)]
  .map((m) => m[0])
  .filter((p) => p !== applicationId);
assert.equal(foreign.length, 0, `nájdený iný hardcoded package: ${foreign.join(', ')}`);

console.log(`ANDROID PACKAGE OK: ${applicationId}, Java ${sourceJava}, SDK ${compileSdk}`);

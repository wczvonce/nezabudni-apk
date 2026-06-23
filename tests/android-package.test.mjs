import assert from 'node:assert/strict';
import fs from 'node:fs';

// Issue 13: package sa ODVODZUJE z konfigurácie, nie je natvrdo zapísaný.
const root = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');

const gradle = read('android/app/build.gradle');
const cap = read('capacitor.config.ts');

const applicationId = gradle.match(/applicationId\s+["']([^"']+)["']/)?.[1];
const namespace = gradle.match(/namespace\s*=\s*["']([^"']+)["']/)?.[1];
const capAppId = cap.match(/appId:\s*['"]([^'"]+)['"]/)?.[1];

assert.ok(applicationId, 'build.gradle musí mať applicationId');
assert.ok(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(applicationId), `neplatný applicationId: ${applicationId}`);

// Konfigurácie sa musia zhodovať – inak jasné zlyhanie (jeden zdroj pravdy).
assert.equal(namespace, applicationId, 'namespace sa musí zhodovať s applicationId');
assert.equal(capAppId, applicationId, 'capacitor appId sa musí zhodovať s applicationId');

// Žiadny iný/zastaraný sk.povraznik.* package názov v testoch/skriptoch/CI.
const scan = (rel) => { try { return read(rel); } catch { return ''; } };
const sources = [
  scan('scripts/check-android-package.mjs'),
  scan('scripts/validate.mjs'),
  scan('.github/workflows/ci.yml'),
].join('\n');
const foreign = [...sources.matchAll(/sk\.povraznik\.[a-z0-9_.]+/g)]
  .map((m) => m[0])
  .filter((p) => p !== applicationId);
assert.equal(foreign.length, 0, `nájdený iný hardcoded package: ${foreign.join(', ')}`);

console.log(`ANDROID PACKAGE OK (odvodený z konfigurácie): ${applicationId}`);

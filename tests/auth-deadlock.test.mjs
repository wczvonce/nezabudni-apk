import assert from 'node:assert/strict';
import fs from 'node:fs';

const auth = fs.readFileSync(new URL('../src/services/auth.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

assert.match(auth, /onAuthStateChange\(\(_event, session\) => \{/);
assert.match(auth, /setTimeout\(\(\) => \{/);
assert.doesNotMatch(auth, /onAuthStateChange\(async/);
assert.doesNotMatch(main, /onAuthChange\(async/);
assert.match(auth, /Kontrola prihlásenia trvá príliš dlho/);
assert.match(main, /authGeneration/, 'Zmeny účtu musia byť chránené generáciou');
assert.match(main, /authTransitionQueue/, 'Zmeny účtu musia byť serializované');
console.log('auth-deadlock.test: OK');

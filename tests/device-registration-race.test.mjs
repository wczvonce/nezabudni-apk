import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('src/services/notification-service.js', 'utf8');

assert.match(source, /let registrationBlocked = false/, 'push registrácia musí mať synchronný logout blok');
assert.match(source, /let deviceMutationQueue = Promise\.resolve\(\)/, 'push mutácie musia mať spoločnú frontu');
assert.match(source, /function enqueueDeviceMutation\(operation\)/, 'registrácia a odregistrácia musia byť serializované');
assert.match(
  source,
  /export function registerCurrentDevice\(\)[\s\S]*return enqueueDeviceMutation/,
  'registerCurrentDevice musí bežať cez serializačnú frontu',
);
assert.match(
  source,
  /export function unregisterCurrentDevice\(\)[\s\S]*registrationBlocked = true;[\s\S]*return enqueueDeviceMutation/,
  'unregister musí zablokovať nové registrácie ešte pred zaradením do fronty',
);
assert.match(
  source,
  /handleSubscriptionChange[\s\S]*!registrationBlocked/,
  'OneSignal listener nesmie registrovať zariadenie počas odhlasovania',
);

console.log('DEVICE REGISTRATION RACE GUARD OK');

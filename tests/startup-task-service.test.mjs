import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile('src/main.js', 'utf8');
const guard = await readFile('src/services/startup-task-service.js', 'utf8');

assert.match(
  main,
  /from '\.\/services\/startup-task-service\.js'/,
  'štart aplikácie musí používať chránenú task-service vrstvu',
);
assert.match(guard, /let desiredGeneration = 0/, 'wrapper používa generáciu kontextu');
assert.match(guard, /generation !== desiredGeneration/, 'oneskorená inicializácia sa musí odmietnuť');
assert.match(
  guard,
  /withAbortTimeout\(\(signal\) => rawFlushOutbox\(signal\)/,
  'štartovací flushOutbox musí dostať AbortSignal',
);
assert.match(
  guard,
  /withAbortTimeout\(\(signal\) => rawFetchTasks\(signal\)/,
  'štartovací fetchTasks musí dostať AbortSignal',
);
assert.doesNotMatch(main, /wczvonce@gmail\.com/, 'demo režim nesmie obsahovať súkromný e-mail');
assert.doesNotMatch(main, /domi\.mikloskova@gmail\.com/, 'demo režim nesmie obsahovať súkromný e-mail');

console.log('STARTUP TASK SERVICE GUARD OK');

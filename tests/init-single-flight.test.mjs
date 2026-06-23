import assert from 'node:assert/strict';
import fs from 'node:fs';
import { singleFlight } from '../src/lib/async.js';

// Súbežní volajúci čakajú na ten istý beh – factory zbehne práve raz.
{
  let calls = 0;
  const run = singleFlight(async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return 'ready'; });
  const [a, b, c] = await Promise.all([run(), run(), run()]);
  assert.equal(calls, 1, 'súbežné volania → jeden beh');
  assert.deepEqual([a, b, c], ['ready', 'ready', 'ready']);
  assert.equal(await run(), 'ready');
  assert.equal(calls, 1, 'po úspechu sa už nespúšťa znova (cache)');
}

// Neúspešný beh je znova spustiteľný (nie trvalo odmietnutý Promise).
{
  let calls = 0;
  const run = singleFlight(async () => { calls += 1; if (calls === 1) throw new Error('boom'); return 'ok'; });
  await assert.rejects(run(), /boom/, 'prvý beh zlyhá');
  assert.equal(await run(), 'ok', 'retry po zlyhaní prejde');
  assert.equal(calls, 2);
}

// Súbežné volania počas zlyhania zdieľajú jeden beh.
{
  let calls = 0;
  const run = singleFlight(async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); throw new Error('fail'); });
  const results = await Promise.allSettled([run(), run()]);
  assert.equal(calls, 1, 'súbežné zlyhanie = jeden beh');
  assert.ok(results.every((r) => r.status === 'rejected'));
}

// ── Statická štruktúra notification-service.js (Issue 10) ──
const ns = fs.readFileSync(new URL('../src/services/notification-service.js', import.meta.url), 'utf8');
assert.match(ns, /singleFlight\(/, 'inicializácia je single-flight');
assert.match(ns, /addEventListener\('click', handleNotificationClick\)/, 'click listener: stabilná referencia, raz');
assert.match(ns, /addEventListener\('change', handleSubscriptionChange\)/, 'subscription listener: stabilná referencia, raz');
assert.doesNotMatch(ns, /if \(!subscriptionListenerBound\)/, 'odstránený starý duplicitný guard');
// Zachované korektné OneSignal API (nesmie sa vrátiť obsolete) – Project context.
assert.doesNotMatch(ns, /addClickListener/, 'žiadne obsolete addClickListener');
assert.match(ns, /hasPermission\(\)/, 'zachované hasPermission()');

console.log('init-single-flight.test: OK');

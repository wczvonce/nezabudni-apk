import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountRecovery } from '../oauth/recovery-controller.js';
const html = await readFile(new URL('../oauth/recovery.html', import.meta.url), 'utf8');
const valid = '#type=recovery&access_token=synthetic&refresh_token=synthetic';
const settle = () => new Promise(resolve => setImmediate(resolve));
async function setup(fragment = '', fail = '') {
  const dom = new JSDOM(html);
  const calls = [];
  const auth = Object.fromEntries(['setSession', 'getUser', 'updateUser', 'signOut', 'resetPasswordForEmail'].map(name => [name, async args => {
    calls.push([name, args]);
    return { error: fail === name ? new Error('private error') : null, data: { user: { id: 'synthetic' } } };
  }]));
  const document = dom.window.document;
  await mountRecovery({ document, auth, fragment, redirectTo: 'https://example.test/oauth/recovery.html' });
  const submit = id => document.getElementById(id).dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  return { document, calls, submit, el: id => document.getElementById(id) };
}
for (const fragment of ['#type=signup&access_token=a&refresh_token=b', '#type=recovery', '#type=recovery&type=recovery&access_token=a&refresh_token=b', '#error=expired']) {
  const p = await setup(fragment);
  assert.equal(p.el('change').hidden, true);
  p.submit('change');
  assert.equal(p.calls.length, 0);
}
for (const fail of ['setSession', 'getUser']) {
  const p = await setup(valid, fail);
  assert.equal(p.el('change').hidden, true);
}
{
  const p = await setup();
  p.el('request').elements.email.value = 'synthetic@example.test';
  p.submit('request'); p.submit('request'); await settle();
  assert.deepEqual(p.calls, [['resetPasswordForEmail', 'synthetic@example.test']]);
  assert.equal(p.el('request').hidden, true);
}
{
  const p = await setup(valid);
  assert.equal(p.el('change').hidden, false);
  p.el('change').elements.password.value = 'long-synthetic-password';
  p.el('change').elements.confirm.value = 'different-password';
  p.submit('change'); await settle();
  assert.equal(p.calls.length, 2);
  p.el('change').elements.confirm.value = 'long-synthetic-password';
  p.submit('change'); p.submit('change'); await settle();
  assert.equal(p.calls.filter(c => c[0] === 'updateUser').length, 1);
  assert.equal(p.el('change').hidden, true);
  assert.equal(p.el('change').elements.password.value, '');
  assert.deepEqual(p.calls.at(-1), ['signOut', { scope: 'local' }]);
}
{
  const p = await setup(valid, 'updateUser');
  p.el('change').elements.password.value = 'long-synthetic-password';
  p.el('change').elements.confirm.value = 'long-synthetic-password';
  p.submit('change'); await settle();
  assert.equal(p.el('change').hidden, false);
  assert.equal(p.el('change').elements.password.value, '');
  assert.ok(!p.el('message').textContent.includes('private error'));
}
const entry = await readFile(new URL('../oauth/recovery.js', import.meta.url), 'utf8');
assert.match(entry, /persistSession: false/);
assert.match(entry, /detectSessionInUrl: false/);
assert.ok(entry.indexOf('history.replaceState') < entry.indexOf('createClient(CONFIG'));
const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
assert.ok(sw.indexOf("pathname.startsWith('/oauth/')") < sw.indexOf("event.request.mode === 'navigate'"));
console.log('Password recovery: invalid/expired links, verified session, request, password validation, retry guard, failure privacy, session isolation and SW exclusion PASS');

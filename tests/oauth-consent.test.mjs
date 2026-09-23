import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { authorizationId, checkedRedirect, mountConsent } from '../oauth/controller.js';

const html = await readFile(new URL('../oauth/consent.html', import.meta.url), 'utf8');
const id = 'test-authorization-12345';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const details = { authorization_id: id, client: { id: '11111111-1111-4111-8111-111111111111', name: 'Test client' },
  user: { email: 'test@example.test' }, scope: 'openid read_tasks', redirect_uri: callback };
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(data = details, search = `?authorization_id=${id}`) {
  const dom = new JSDOM(html, { url: 'https://example.test/oauth/consent.html' });
  const calls = [];
  const auth = {
    signInWithPassword: async value => { calls.push(['login', value]); return { data: {}, error: null }; },
    oauth: {
      getAuthorizationDetails: async value => { calls.push(['details', value]); return { data, error: null }; },
      approveAuthorization: async (...args) => { calls.push(['approve', ...args]); return { data: { redirect_url: `${callback}?code=synthetic` } }; },
      denyAuthorization: async (...args) => { calls.push(['deny', ...args]); return { data: { redirect_url: `${callback}?error=access_denied` } }; },
    },
  };
  const document = dom.window.document;
  mountConsent({ document, auth, search, navigate: url => calls.push(['navigate', url]),
    grantIntegration: async (...args) => calls.push(['grant', ...args]) });
  const el = name => document.getElementById(name);
  const login = async () => {
    el('login').elements.namedItem('email').value = 'test@example.test';
    el('login').elements.namedItem('password').value = 'synthetic-test-password';
    el('login').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await settle();
  };
  return { calls, auth, el, login, document };
}

for (const input of ['', '?authorization_id=short', `?authorization_id=${id}&authorization_id=${id}`, '?authorization_id=%3Cscript%3E']) {
  assert.throws(() => authorizationId(input));
  const page = setup(details, input);
  assert.equal(page.el('login').hidden, true);
  assert.equal(page.calls.length, 0);
}
for (const url of ['javascript:alert(1)', 'data:text/html,test', 'http://example.test/callback', 'https://user:pass@example.test']) {
  assert.throws(() => checkedRedirect(url));
}
assert.equal(checkedRedirect('http://127.0.0.1:8888/callback'), 'http://127.0.0.1:8888/callback');

{
  const page = setup();
  page.el('approve').click();
  assert.equal(page.calls.length, 0, 'Cannot approve before loading verified details');
  await page.login();
  assert.deepEqual(page.calls.map(x => x[0]), ['login', 'details']);
  assert.equal(page.el('consent').hidden, false);
  assert.equal(page.el('login').elements.namedItem('password').value, '');
  page.el('approve').click();
  page.el('approve').click();
  await settle();
  assert.equal(page.calls.filter(x => x[0] === 'approve').length, 1);
  assert.deepEqual(page.calls.find(x => x[0] === 'approve'), ['approve', id, { skipBrowserRedirect: true }]);
  assert.equal(page.calls.at(-1)[0], 'navigate');
}
{
  const page = setup();
  await page.login();
  page.el('deny').click();
  await settle();
  assert.equal(page.calls.filter(x => x[0] === 'approve').length, 0);
  assert.equal(page.calls.filter(x => x[0] === 'deny').length, 1);
}
{
  const page = setup({ ...details, scope: 'openid admin', client: { ...details.client, name: '<img src=x onerror=alert(1)>' } });
  await page.login();
  assert.equal(page.el('approve').disabled, true);
  assert.equal(page.el('client').querySelector('img'), null, 'Client metadata must be text, never HTML');
  page.el('approve').click();
  assert.equal(page.calls.length, 2);
}
{
  const page = setup({ ...details, authorization_id: 'another-request' });
  await page.login();
  assert.equal(page.el('consent').hidden, true);
}
{
  const page = setup({ redirect_url: `${callback}?code=existing` });
  await page.login();
  assert.equal(page.calls.some(x => x[0] === 'navigate'), false, 'Even existing grants require explicit navigation');
  page.el('approve').click();
  await settle();
  assert.equal(page.calls.at(-1)[0], 'navigate');
  assert.equal(page.calls.some(x => x[0] === 'approve'), false);
  assert.equal(page.calls.some(x => x[0] === 'grant'), false);
}
{
  const page = setup({ redirect_url: 'javascript:alert(1)' });
  await page.login();
  assert.equal(page.el('consent').hidden, true);
  assert.equal(page.calls.some(x => x[0] === 'navigate'), false);
}
{
  const page = setup();
  page.auth.signInWithPassword = async () => ({ error: { message: 'private diagnostic must not display' } });
  await page.login();
  assert.equal(page.el('consent').hidden, true);
  assert.equal(page.document.body.textContent.includes('private diagnostic'), false);
}
console.log('OAuth consent: validation, explicit consent, refusal, XSS, retry and redirect checks passed.');

// Exact scope combination observed in ChatGPT's authorization request.
{
  const page = setup({ ...details, scope: 'openid email offline_access' });
  await page.login();
  assert.equal(page.el('approve').disabled, false);
  assert.match(page.el('scopes').textContent, /Obnovovanie prihlásenia/);
  assert.deepEqual(page.calls.map(x => x[0]), ['login', 'details'], 'No automatic grant after login');
  page.el('approve').click();
  page.el('approve').click();
  await settle();
  assert.deepEqual(page.calls.find(x => x[0] === 'grant'),
    ['grant', details.client.id, ['create_task', 'read_tasks', 'upload_attachment']],
    'offline_access must not become a task permission');
  assert.equal(page.calls.filter(x => x[0] === 'approve').length, 1);
  assert.equal(page.calls.at(-1)[0], 'navigate');
}
{
  const page = setup({ ...details, scope: 'openid email offline_access' });
  await page.login();
  page.el('deny').click();
  await settle();
  assert.equal(page.calls.some(x => x[0] === 'grant' || x[0] === 'approve'), false);
  assert.equal(page.calls.filter(x => x[0] === 'deny').length, 1);
}
for (const scope of ['openid email offline_access admin', 'openid offline_access_unknown', 'openid OFFLINE_ACCESS']) {
  const page = setup({ ...details, scope });
  await page.login();
  assert.equal(page.el('approve').disabled, true);
  page.el('approve').click();
  await settle();
  assert.deepEqual(page.calls.map(x => x[0]), ['login', 'details']);
}
console.log('OAuth offline_access: explicit consent, exact scope allowlist, refusal, retry and unchanged task grants passed.');

const scopeLabels = Object.freeze({
  openid: 'Overenie totožnosti účtu',
  profile: 'Základné údaje profilu',
  email: 'E-mailová adresa účtu',
  create_task: 'Vytváranie úloh',
  read_tasks: 'Čítanie úloh vo vašej skupine',
  upload_attachment: 'Pridávanie príloh k úlohám vo vašej skupine',
});

export function authorizationId(search) {
  const params = new URLSearchParams(search);
  const values = params.getAll('authorization_id');
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{8,200}$/.test(values[0])) {
    throw new Error('invalid_authorization');
  }
  return values[0];
}

// Redirects come only from the authenticated Supabase response, never URL parameters.
export function checkedRedirect(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('unsafe_redirect');
  }
  return url.href;
}

export function mountConsent({ document, auth, search, navigate, grantIntegration }) {
  const el = id => document.getElementById(id);
  const message = value => { el('message').textContent = value; };
  let id;
  let busy = false;
  let reviewed = false;
  let existingRedirect = null;
  let allowed = false;
  let oauthClientId = null;
  const lock = value => {
    busy = value;
    for (const button of document.querySelectorAll('button')) button.disabled = value;
    if (!value) el('approve').disabled = !allowed;
  };
  const failure = () => message('Požiadavku sa nepodarilo overiť. Otvorte nové pripojenie z ChatGPT alebo Codexu.');
  try { id = authorizationId(search); }
  catch { failure(); return; }
  el('login').hidden = false;
  message('Prihláste sa svojím účtom Nezabudni.');

  el('login').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || reviewed) return;
    lock(true);
    try {
      const email = el('login').elements.namedItem('email').value.trim();
      const passwordField = el('login').elements.namedItem('password');
      const password = passwordField.value;
      passwordField.value = '';
      const login = await auth.signInWithPassword({ email, password });
      if (login.error) { message('Prihlásenie sa nepodarilo. Skontrolujte e-mail a heslo.'); return; }
      const { data, error } = await auth.oauth.getAuthorizationDetails(id);
      if (error || !data) throw new Error('authorization_failed');
      if ('redirect_url' in data) {
        existingRedirect = checkedRedirect(data.redirect_url);
        el('client').textContent = 'Už povolené pripojenie';
        el('account').textContent = email;
        el('destination').textContent = new URL(existingRedirect).origin;
        el('approve').textContent = 'Pokračovať do pripojenej aplikácie';
        el('deny').textContent = 'Zrušiť návrat';
        allowed = true;
      } else {
        if (data.authorization_id !== id || !data.client?.name || !data.user?.email) throw new Error('invalid_details');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.client.id || '')) throw new Error('invalid_client');
        oauthClientId = data.client.id;
        el('client').textContent = data.client.name;
        el('account').textContent = data.user.email;
        el('destination').textContent = new URL(checkedRedirect(data.redirect_uri)).origin;
        const scopes = String(data.scope || '').split(/\s+/).filter(Boolean);
        allowed = scopes.length > 0 && scopes.every(scope => Object.hasOwn(scopeLabels, scope));
        for (const scope of scopes) {
          const item = document.createElement('li');
          item.textContent = scopeLabels[scope] || `Nepodporované oprávnenie: ${scope}`;
          el('scopes').append(item);
        }
      }
      reviewed = true;
      el('login').hidden = true;
      el('consent').hidden = false;
      message(allowed ? 'Skontrolujte pripojenie a rozhodnite sa.' : 'Neznáme oprávnenia nemožno povoliť.');
    } catch { failure(); }
    finally { lock(false); }
  });

  async function decide(approve) {
    if (busy || !reviewed || (approve && !allowed)) return;
    lock(true);
    try {
      if (existingRedirect) {
        if (approve) navigate(existingRedirect);
        else { el('consent').hidden = true; message('Návrat bol zrušený. Existujúci súhlas tým nie je odvolaný.'); }
        return;
      }
      const method = approve ? 'approveAuthorization' : 'denyAuthorization';
      if (approve) {
        if (!grantIntegration || !oauthClientId) throw new Error('integration_grant_unavailable');
        await grantIntegration(oauthClientId, ['create_task', 'read_tasks', 'upload_attachment']);
      }
      const { data, error } = await auth.oauth[method](id, { skipBrowserRedirect: true });
      if (error || !data?.redirect_url) throw new Error('decision_failed');
      navigate(checkedRedirect(data.redirect_url));
      // Keep controls locked after successful submission, including slow navigation.
    } catch { failure(); lock(false); }
  }
  el('approve').addEventListener('click', () => decide(true));
  el('deny').addEventListener('click', () => decide(false));
}

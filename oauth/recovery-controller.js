export async function mountRecovery({ document, auth, fragment, redirectTo }) {
  const message = document.getElementById('message');
  const request = document.getElementById('request');
  const change = document.getElementById('change');
  let busy = false;
  let verified = false;
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  request.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const email = request.elements.namedItem('email').value.trim();
    if (!email || !request.reportValidity()) return;
    busy = true;
    request.querySelector('button').disabled = true;
    try {
      const { error } = await auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
      request.hidden = true;
      message.textContent = 'Ak účet existuje, dostanete obnovovací e-mail. Skontrolujte aj spam a otvorte najnovší odkaz.';
    } catch {
      message.textContent = 'E-mail sa nepodarilo odoslať. Skúste to neskôr.';
      request.querySelector('button').disabled = false;
    } finally { busy = false; }
  });
  change.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !verified) return;
    const password = change.elements.namedItem('password').value;
    const confirmation = change.elements.namedItem('confirm').value;
    if (password.length < 12 || password.length > 128 || password !== confirmation) {
      message.textContent = 'Heslá musia byť rovnaké a mať 12 až 128 znakov.';
      return;
    }
    busy = true;
    change.querySelector('button').disabled = true;
    try {
      const { error } = await auth.updateUser({ password });
      if (error) throw error;
      verified = false;
      change.reset();
      change.hidden = true;
      message.textContent = 'Heslo bolo zmenené. Prihláste sa do Nezabudni novým heslom. Ak aplikácia na inom zariadení požiada o prihlásenie, použite nové heslo.';
      // Only this short-lived recovery session; never global sign-out.
      try { await auth.signOut({ scope: 'local' }); } catch { /* memory-only session */ }
    } catch {
      change.reset();
      message.textContent = 'Heslo sa nepodarilo zmeniť. Skúste silnejšie heslo alebo si vyžiadajte nový obnovovací odkaz.';
      change.querySelector('button').disabled = false;
    } finally { busy = false; }
  });
  if (!fragment) {
    message.textContent = 'Zadajte e-mail svojho účtu Nezabudni.';
    request.hidden = false;
    return;
  }
  try {
    for (const key of ['type', 'access_token', 'refresh_token']) {
      if (params.getAll(key).length !== 1 || !params.get(key)) throw new Error('invalid');
    }
    if (params.has('error') || params.get('type') !== 'recovery') throw new Error('invalid');
    const { error } = await auth.setSession({ access_token: params.get('access_token'), refresh_token: params.get('refresh_token') });
    if (error) throw error;
    const result = await auth.getUser();
    if (result.error || !result.data?.user?.id) throw new Error('invalid');
    verified = true;
    message.textContent = 'Odkaz je overený. Nastavte si nové heslo.';
    change.hidden = false;
  } catch {
    message.textContent = 'Odkaz je neplatný alebo vypršal. Vyžiadajte si nový e-mail.';
    request.hidden = false;
  }
}

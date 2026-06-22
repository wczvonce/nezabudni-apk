import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = await readFile('src/config.js', 'utf8');
assert.match(config, /https:\/\/ofwouqpqzcpjnigcgygz\.supabase\.co/, 'Chýba správny Supabase Project URL');
assert.match(config, /sb_publishable_q5xQ1rNFeYQsuUtjXllIvg_aJft17Qy/, 'Chýba správny Supabase publishable key');
assert.match(config, /6b9193d7-db17-4e17-9320-4dcb7c410e76/, 'Chýba správny OneSignal App ID');
assert.match(config, /VITE_ALLOW_DEMO_MODE \?\? 'false'/, 'Cloudová testovacia verzia nemá mať demo režim predvolene zapnutý');
assert.doesNotMatch(config, /service[_-]?role/i, 'Frontend nesmie obsahovať service-role kľúč');
assert.doesNotMatch(config, /ONESIGNAL_REST_API_KEY/, 'Frontend nesmie obsahovať OneSignal REST API key');
console.log('PUBLIC CONFIG OK');

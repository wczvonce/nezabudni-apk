import { createHash, randomBytes } from 'node:crypto';

const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

console.log('NEZABUDNI ACTION TOKEN (zobrazí sa iba teraz):');
console.log(token);
console.log('\nSHA-256 HASH (tento sa uloží do Supabase):');
console.log(tokenHash);
console.log('\nToken necommituj, neposielaj e-mailom a nevkladaj do .env frontendu.');

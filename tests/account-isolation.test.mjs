import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const service = await readFile('src/services/task-service.js', 'utf8');
const ui = await readFile('src/ui/app-ui.js', 'utf8');
assert.match(service, /function contextSnapshot\(\)/, 'Task service musí zachytiť lokálny používateľský kontext');
assert.match(service, /function assertCurrent\(snapshot\)/, 'Task service musí odmietnuť odpoveď starého účtu');
assert.match(service, /const oldDb = db;[\s\S]*db = null;[\s\S]*context = null;[\s\S]*oldDb\?\.close/, 'Pri odhlásení sa musí globálny kontext odpojiť pred zatvorením starej DB');
assert.doesNotMatch(service, /await db\.replaceTasks/, 'Dobiehajúca synchronizácia nesmie zapisovať cez globálnu DB');
assert.match(ui, /const userId = state\.user\.id;[\s\S]*getState\(\)\.user\?\.id !== userId/, 'UI synchronizácia musí ignorovať odpoveď starého účtu');
console.log('ACCOUNT ISOLATION OK');

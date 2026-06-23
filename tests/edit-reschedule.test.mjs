import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const m001 = read('../supabase/migrations/001_schema.sql');
const m004 = read('../supabase/migrations/004_deep_audit_fixes.sql');
const ui = read('../src/ui/app-ui.js');

// Issue 4: edit aktívnej úlohy ZÁMERNE resetuje a preplánuje alarm; staré a nové
// nesmú bežať naraz; terminálne úlohy sa nealarmujú.

// api_update_task resetuje stav pripomienok a zvyšuje verziu (invaliduje staré).
assert.match(m004, /api_update_task/, 'api_update_task existuje');
assert.match(m004, /reminders_sent=0/, 'reset počítadla pripomienok pri edite');
assert.match(m004, /snoozed_until=null/, 'reset snooze pri edite');
assert.match(m004, /acknowledged_by=null,acknowledged_at=null/, 'reset potvrdenia pri edite');
assert.match(m004, /version=version\+1/, 'edit zvyšuje verziu');
assert.match(m004, /enqueue_task_notification_jobs\(v_task\)/, 'edit preplánuje notifikačné joby');

// enqueue najprv ZRUŠÍ staré joby → nikdy nie dva alarmy naraz.
assert.match(m001, /enqueue_task_notification_jobs[\s\S]{0,600}cancel_task_notification_jobs/, 'enqueue najprv zruší staré joby');
// enqueue posiela len pre pending, neacknowledged, nedeleted (terminálne sa nealarmujú).
assert.match(m001, /status <> 'pending' or .*deleted_at is not null or .*acknowledged_at is not null.*then return/i, 'terminálne/acknowledged úlohy sa nealarmujú');

// Lokálny alarm je kľúčovaný verziou → po edite (version+1) starý alarm nezbehne.
assert.match(ui, /\$\{t\.id\}:\$\{t\.version\}:\$\{effectiveDue\(t\)\}/, 'alarm key obsahuje verziu (invalidácia po edite)');

console.log('edit-reschedule.test: OK');

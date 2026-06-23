import assert from 'node:assert/strict';
import fs from 'node:fs';
import { localAlarmAllowed, reminderIntervalMs } from '../src/lib/reminders.js';

const base = { status: 'pending', deleted_at: null, acknowledged_at: null, assigned_to: 'u1', max_reminders: 3, reminders_sent: 0, reminder_interval_seconds: 60 };
const now = 1_000_000_000;
const opts = (over = {}) => ({ userId: 'u1', now, dueMs: now - 1000, lastShownAt: 0, shownCount: 0, ...over });

// interval (konzistentná interpretácia)
assert.equal(reminderIntervalMs({ reminder_interval_seconds: 60 }), 60_000);
assert.equal(reminderIntervalMs({ reminder_interval_seconds: 10 }), 60_000, 'pod 60s sa zdvihne na 60s');
assert.equal(reminderIntervalMs({ reminder_interval_seconds: 120 }), 120_000);
assert.equal(reminderIntervalMs({ reminder_interval_seconds: 0 }), 60_000, 'neplatný interval = default');
assert.equal(reminderIntervalMs({}), 60_000, 'chýbajúci interval = default');

// max_reminders – hraničné hodnoty
assert.equal(localAlarmAllowed({ ...base, max_reminders: 0 }, opts()), false, 'max=0 → nikdy');
assert.equal(localAlarmAllowed({ ...base, max_reminders: 1 }, opts({ shownCount: 0 })), true, 'max=1, 0 zobrazené → smie');
assert.equal(localAlarmAllowed({ ...base, max_reminders: 1 }, opts({ shownCount: 1 })), false, 'max=1, 1 zobrazené → stop');
assert.equal(localAlarmAllowed({ ...base, max_reminders: 3 }, opts({ shownCount: 2 })), true, 'posledná povolená');
assert.equal(localAlarmAllowed({ ...base, max_reminders: 3 }, opts({ shownCount: 3 })), false, 'nad limit');
assert.equal(localAlarmAllowed({ ...base, max_reminders: 3 }, opts({ shownCount: 10 })), false, 'už dávno nad limit (staré dáta)');

// terminálne / priradenie
assert.equal(localAlarmAllowed({ ...base, status: 'completed' }, opts()), false, 'completed → nie');
assert.equal(localAlarmAllowed({ ...base, status: 'cancelled' }, opts()), false, 'cancelled → nie');
assert.equal(localAlarmAllowed({ ...base, deleted_at: 'x' }, opts()), false, 'deleted → nie');
assert.equal(localAlarmAllowed({ ...base, acknowledged_at: 'x' }, opts()), false, 'acknowledged → nie');
assert.equal(localAlarmAllowed({ ...base, assigned_to: 'u2' }, opts()), false, 'iný príjemca → nie');

// čas / interval
assert.equal(localAlarmAllowed(base, opts({ dueMs: now + 1000 })), false, 'ešte nie je čas');
assert.equal(localAlarmAllowed(base, opts({ lastShownAt: now - 30_000 })), false, 'v rámci intervalu → nie');
assert.equal(localAlarmAllowed(base, opts({ lastShownAt: now - 61_000 })), true, 'po intervale → smie');

// neplatný interval nesmie obísť limit
assert.equal(localAlarmAllowed({ ...base, reminder_interval_seconds: null, max_reminders: 1 }, opts({ shownCount: 1 })), false);

// statická kontrola app-ui.js
const ui = fs.readFileSync(new URL('../src/ui/app-ui.js', import.meta.url), 'utf8');
assert.match(ui, /localAlarmAllowed/, 'checkDueAlarm používa localAlarmAllowed');
assert.match(ui, /shownAlarmCount/, 'lokálne počítadlo pripomienok');

console.log('reminder-limits.test: OK');

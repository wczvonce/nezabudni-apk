import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const m001 = read('../supabase/migrations/001_schema.sql');
const m004 = read('../supabase/migrations/004_deep_audit_fixes.sql');

// Issue 5: opakujúca séria sa nesmie zaseknúť ani duplikovať.

// DB-level uniqueness occurrencie → žiadne duplicitné výskyty.
assert.match(m001, /unique\s*\(\s*series_id\s*,\s*occurrence_at\s*\)/i, 'unique(series_id, occurrence_at)');

// next_occurrence je timezone-aware (rieši DST cez "at time zone").
assert.match(m001, /function public\.next_occurrence/, 'next_occurrence existuje');
assert.match(m001, /at time zone/i, 'next_occurrence rieši časové pásmo/DST');

// 004: deterministická, idempotentná generácia s guardom proti zaseknutiu/cyklu.
assert.match(m004, /create_next_recurring_task/, 'create_next_recurring_task');
assert.match(m004, /v_guard/, 'guard proti nekonečnej generácii');
assert.match(m004, /RECURRENCE_GUARD_EXCEEDED/, 'jasná chyba pri prekročení guardu');
assert.match(m004, /while\s+v_next\s*<=\s*now\(\)/i, 'catch-up: preskočí historické výskyty na najbližší budúci');
assert.match(m004, /on conflict\s*\(\s*series_id\s*,\s*occurrence_at\s*\)\s*do nothing/i, 'idempotentný insert (žiadne duplicitné occurrencie)');

console.log('recurrence-safety.test: OK');

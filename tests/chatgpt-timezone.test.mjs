import assert from 'node:assert/strict';
import { LocalTimeError, resolveLocalDateTime } from '../supabase/functions/chatgpt-api/timezone.js';

const winter = resolveLocalDateTime({
  localDate: '2030-01-15',
  localTime: '22:00',
  timeZone: 'Europe/Bratislava',
});
assert.equal(winter.dueAt, '2030-01-15T21:00:00.000Z');
assert.equal(winter.utcOffset, '+01:00');

const summer = resolveLocalDateTime({
  localDate: '2030-07-15',
  localTime: '22:00',
  timeZone: 'Europe/Bratislava',
});
assert.equal(summer.dueAt, '2030-07-15T20:00:00.000Z');
assert.equal(summer.utcOffset, '+02:00');

assert.throws(
  () => resolveLocalDateTime({
    localDate: '2026-03-29',
    localTime: '02:30',
    timeZone: 'Europe/Bratislava',
  }),
  (error) => error instanceof LocalTimeError && error.code === 'NONEXISTENT_LOCAL_TIME',
);

let ambiguous;
try {
  resolveLocalDateTime({
    localDate: '2026-10-25',
    localTime: '02:30',
    timeZone: 'Europe/Bratislava',
  });
} catch (error) {
  ambiguous = error;
}
assert.ok(ambiguous instanceof LocalTimeError);
assert.equal(ambiguous.code, 'AMBIGUOUS_LOCAL_TIME');
assert.equal(ambiguous.details.choices.length, 2);

const earlier = resolveLocalDateTime({
  localDate: '2026-10-25',
  localTime: '02:30',
  timeZone: 'Europe/Bratislava',
  ambiguousTimeChoice: 'earlier',
});
const later = resolveLocalDateTime({
  localDate: '2026-10-25',
  localTime: '02:30',
  timeZone: 'Europe/Bratislava',
  ambiguousTimeChoice: 'later',
});
assert.equal(earlier.dueAt, '2026-10-25T00:30:00.000Z');
assert.equal(earlier.utcOffset, '+02:00');
assert.equal(later.dueAt, '2026-10-25T01:30:00.000Z');
assert.equal(later.utcOffset, '+01:00');

console.log('CHATGPT TIMEZONE OK');

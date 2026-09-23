// @ts-check

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SEARCH_WINDOW_MINUTES = 4 * 60;

/** @typedef {{year:number,month:number,day:number,hour:number,minute:number}} LocalParts */
/** @typedef {'earlier'|'later'} AmbiguousTimeChoice */
/** @typedef {{choice:string,due_at:string,utc_offset:string}} AmbiguousChoice */

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatterCache = new Map();

export class LocalTimeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>=} details
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LocalTimeError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} timeZone */
function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * @param {number} epochMs
 * @param {string} timeZone
 * @returns {LocalParts}
 */
function localPartsAt(epochMs, timeZone) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') result[part.type] = part.value;
  }
  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour: Number(result.hour),
    minute: Number(result.minute),
  };
}

/** @param {string} localDate */
function parseLocalDate(localDate) {
  const match = DATE_RE.exec(localDate);
  if (!match) {
    throw new LocalTimeError('INVALID_LOCAL_DATE', 'local_date musí byť vo formáte YYYY-MM-DD.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new LocalTimeError('INVALID_LOCAL_DATE', 'local_date nie je platný kalendárny dátum.');
  }
  return { year, month, day };
}

/** @param {string} localTime */
function parseLocalTime(localTime) {
  const match = TIME_RE.exec(localTime);
  if (!match) {
    throw new LocalTimeError('INVALID_LOCAL_TIME', 'local_time musí byť vo formáte HH:MM.');
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * @param {number} epochMs
 * @param {string} timeZone
 */
function offsetMinutesAt(epochMs, timeZone) {
  const local = localPartsAt(epochMs, timeZone);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return Math.round((localAsUtc - epochMs) / 60_000);
}

/** @param {number} minutes */
function offsetText(minutes) {
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const mins = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${mins}`;
}

/**
 * @param {Date|string|number} instant
 * @param {string} timeZone
 */
export function formatInstantInZone(instant, timeZone) {
  const epochMs = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(epochMs)) throw new LocalTimeError('INVALID_INSTANT', 'Neplatný časový okamih.');
  const parts = localPartsAt(epochMs, timeZone);
  return {
    localDate: `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    localTime: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    utcOffset: offsetText(offsetMinutesAt(epochMs, timeZone)),
  };
}

/**
 * @param {{localDate:string,localTime:string,timeZone:string,ambiguousTimeChoice?:AmbiguousTimeChoice|null}} input
 */
export function resolveLocalDateTime({ localDate, localTime, timeZone, ambiguousTimeChoice = null }) {
  if (timeZone !== 'Europe/Bratislava') {
    throw new LocalTimeError('UNSUPPORTED_TIMEZONE', 'Podporované je iba časové pásmo Europe/Bratislava.');
  }
  if (ambiguousTimeChoice !== null && !['earlier', 'later'].includes(ambiguousTimeChoice)) {
    throw new LocalTimeError('INVALID_AMBIGUOUS_TIME_CHOICE', 'ambiguous_time_choice musí byť earlier alebo later.');
  }

  const date = parseLocalDate(localDate);
  const time = parseLocalTime(localTime);
  const naiveUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  /** @type {number[]} */
  const matches = [];

  for (
    let candidate = naiveUtc - SEARCH_WINDOW_MINUTES * 60_000;
    candidate <= naiveUtc + SEARCH_WINDOW_MINUTES * 60_000;
    candidate += 60_000
  ) {
    const parts = localPartsAt(candidate, timeZone);
    if (
      parts.year === date.year &&
      parts.month === date.month &&
      parts.day === date.day &&
      parts.hour === time.hour &&
      parts.minute === time.minute
    ) {
      matches.push(candidate);
    }
  }

  const uniqueMatches = [...new Set(matches)].sort((a, b) => a - b);
  if (uniqueMatches.length === 0) {
    throw new LocalTimeError(
      'NONEXISTENT_LOCAL_TIME',
      'Tento miestny čas neexistuje pre zmenu na letný čas. Vyber iný čas.',
      { local_date: localDate, local_time: localTime, timezone: timeZone },
    );
  }

  /** @type {AmbiguousChoice[]} */
  const choices = uniqueMatches.map((epochMs, index) => ({
    choice: index === 0 ? 'earlier' : 'later',
    due_at: new Date(epochMs).toISOString(),
    utc_offset: offsetText(offsetMinutesAt(epochMs, timeZone)),
  }));

  if (uniqueMatches.length > 1 && !ambiguousTimeChoice) {
    throw new LocalTimeError(
      'AMBIGUOUS_LOCAL_TIME',
      'Tento miestny čas nastáva pri zmene na zimný čas dvakrát. Vyber skorší alebo neskorší výskyt.',
      { local_date: localDate, local_time: localTime, timezone: timeZone, choices },
    );
  }

  const selectedIndex = uniqueMatches.length === 1 || ambiguousTimeChoice === 'earlier' ? 0 : uniqueMatches.length - 1;
  const selected = uniqueMatches[selectedIndex];
  return {
    dueAt: new Date(selected).toISOString(),
    localDate,
    localTime,
    timezone: timeZone,
    utcOffset: offsetText(offsetMinutesAt(selected, timeZone)),
  };
}

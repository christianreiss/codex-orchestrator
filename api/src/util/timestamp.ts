/**
 * ISO 8601 helpers. Server-authored timestamps retain the legacy second
 * precision, while auth-file generations may carry RFC3339 nanoseconds.
 */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function isoOffsetSeconds(seconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
export function isRfc3339(value: string): boolean {
  return typeof value === 'string' && parseRfc3339Millis(value) !== null;
}

export function parseRfc3339Millis(value: string): number | null {
  const match = RFC3339.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Parse an RFC3339 instant without collapsing sub-millisecond generations. */
export function parseRfc3339Nanos(value: string): bigint | null {
  const match = RFC3339.exec(value);
  if (!match || parseRfc3339Millis(value) === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  const offsetSign = match[8] === 'Z' || match[9] === '+' ? 1 : -1;
  const offsetMillis = offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  // Date.UTC treats years 0..99 as 1900..1999. setUTCFullYear preserves the
  // four-digit RFC3339 year literally, including historical values.
  const epoch = new Date(0);
  epoch.setUTCFullYear(year, month - 1, day);
  epoch.setUTCHours(hour, minute, second, 0);
  const epochSecondMillis = epoch.getTime() - offsetMillis;
  const fraction = `${match[7] ?? ''}000000000`.slice(0, 9);
  return BigInt(epochSecondMillis) * 1_000_000n + BigInt(fraction || '0');
}

export function compareRfc3339(a: string, b: string): number | null {
  const aNanos = parseRfc3339Nanos(a);
  const bNanos = parseRfc3339Nanos(b);
  if (aNanos === null || bNanos === null) return null;
  return aNanos < bNanos ? -1 : aNanos > bNanos ? 1 : 0;
}

export function formatRfc3339Nanos(epochNanos: bigint): string {
  let seconds = epochNanos / 1_000_000_000n;
  let nanos = epochNanos % 1_000_000_000n;
  if (nanos < 0n) {
    seconds -= 1n;
    nanos += 1_000_000_000n;
  }
  const base = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  const fraction = nanos.toString().padStart(9, '0').replace(/0+$/, '');
  return `${base}${fraction ? `.${fraction}` : ''}Z`;
}

export function normalizeRfc3339Nanos(value: string): string | null {
  const nanos = parseRfc3339Nanos(value);
  return nanos === null ? null : formatRfc3339Nanos(nanos);
}

export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

import { z } from 'zod';

// Persisted clients can send minute precision, fractional seconds of arbitrary
// precision and, where offsets are accepted, either +hh:mm or +hhmm. Preserve
// the original string for hashing, signatures and application-specific parsing.
const date = z.regexes.date.source.slice(1, -1);
const time = '(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?';

function datetime(zone: string) {
  return z.string().regex(new RegExp(`^${date}T${time}${zone}$`), 'Invalid datetime').meta({ format: 'date-time' });
}

export const wireUtcDateTime = datetime('Z');
export const wireOffsetDateTime = datetime('(?:Z|[+-]\\d{2}:?\\d{2})');

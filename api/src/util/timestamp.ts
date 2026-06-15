/**
 * ISO 8601 helpers. The legacy PHP stored ISO strings with second precision;
 * we keep that convention for compatibility (millisecond strings would still
 * parse but make compare strings drift across PHP/Node-written rows).
 */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function isoOffsetSeconds(seconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
export function isRfc3339(value: string): boolean {
  return typeof value === 'string' && RFC3339.test(value);
}

export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

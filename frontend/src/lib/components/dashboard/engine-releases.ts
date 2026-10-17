/**
 * "checked 5m ago" for an upstream release lookup. `stale` means the fetch has
 * been failing: the API keeps serving the expired cache rather than breaking
 * updates, so an ageing check time is the only sign the whole fleet is being
 * handed an old target.
 */
export function checkedHint(iso?: string | null, stale?: boolean, now = Date.now()): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  const mins = (now - ts) / 60_000;
  const prefix = stale ? "stale, checked" : "checked";
  if (mins < 1) return `${prefix} just now`;
  if (mins < 60) return `${prefix} ${Math.round(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${prefix} ${Math.round(hours)}h ago`;
  return `${prefix} ${Math.round(hours / 24)}d ago`;
}

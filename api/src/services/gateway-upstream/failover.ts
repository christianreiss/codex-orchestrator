/**
 * Failover policy for the upstream forward. Keys are used sticky round robin:
 * every request starts at the provider's current key, and a key that answers
 * after the ones before it failed becomes the new current key, so the gateway
 * stays on it until it fails in turn (see `orderCandidates`).
 *
 * Failover happens only before the first response byte reaches the client, and
 * only for answers that say "this key, not this request": a connection failure,
 * 401, 403 or 429. The last key's 401/403/429 is passed through unchanged and
 * leaves the current key alone; every other status (including 5xx and
 * Anthropic's 529) is committed as the answer.
 *
 * A 401 does not invalidate a key on the spot: OpenAI answers 401 for a
 * restricted key that lacks one scope, so any gateway client could otherwise
 * switch a working key off. It puts the key in a short cooldown and asks for a
 * background re-verification; only that verification marks it invalid.
 */
import type { IncomingHttpHeaders } from 'node:http';

export type StatusClass = 'unauthorized' | 'forbidden' | 'rate_limited' | 'commit';

export function classifyStatus(status: number): StatusClass {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  return 'commit';
}

export const RETRY_AFTER_DEFAULT_S = 30;
export const RETRY_AFTER_MIN_S = 1;
export const RETRY_AFTER_MAX_S = 300;
/** After a 401 the key waits this long while its re-verification runs. */
export const UNAUTHORIZED_COOLDOWN_S = 60;

function header(headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Cooldown after a 429, from `retry-after-ms` / `retry-after`, clamped to 1–300 s (default 30 s). */
export function retryAfterSeconds(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  now = Date.now(),
): number {
  const clamp = (s: number) => Math.min(RETRY_AFTER_MAX_S, Math.max(RETRY_AFTER_MIN_S, Math.ceil(s)));
  const ms = Number(header(headers, 'retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return clamp(ms / 1000);
  const raw = header(headers, 'retry-after')?.trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return clamp(seconds);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return clamp((at - now) / 1000);
  }
  return RETRY_AFTER_DEFAULT_S;
}

/** In-process cooldowns per provider key id. Lost on restart, which is fine. */
export class KeyCooldowns {
  private readonly until = new Map<number, number>();

  set(id: number, seconds: number, now = Date.now()): void {
    const next = now + seconds * 1000;
    if ((this.until.get(id) ?? 0) < next) this.until.set(id, next);
  }

  /** Milliseconds-epoch the key cools down until, or null when it is ready. */
  coolingUntil(id: number, now = Date.now()): number | null {
    const at = this.until.get(id);
    if (at === undefined) return null;
    if (at <= now) {
      this.until.delete(id);
      return null;
    }
    return at;
  }

  clear(id: number): void {
    this.until.delete(id);
  }
}

/**
 * Candidate order is sticky round robin: `sort_order`, then id, rotated so the
 * provider's current key (the one that last answered) comes first and the
 * keys after it follow, wrapping around to the top. A current key that is no
 * longer a candidate (deleted, paused, invalid) or none at all starts at the
 * top. Keys in cooldown then move to the end (earliest-ready first) but stay
 * candidates, so a single key in cooldown is still tried rather than refusing
 * the request.
 */
export function orderCandidates<T extends { id: number; sortOrder: number }>(
  keys: readonly T[],
  cooldowns: KeyCooldowns,
  now = Date.now(),
  currentId: number | null = null,
): T[] {
  const sorted = [...keys].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const start = Math.max(0, sorted.findIndex((key) => key.id === currentId));
  const rotated = [...sorted.slice(start), ...sorted.slice(0, start)];
  const ready = rotated.filter((key) => cooldowns.coolingUntil(key.id, now) === null);
  const cooling = rotated
    .filter((key) => cooldowns.coolingUntil(key.id, now) !== null)
    .sort((a, b) => cooldowns.coolingUntil(a.id, now)! - cooldowns.coolingUntil(b.id, now)!);
  return [...ready, ...cooling];
}

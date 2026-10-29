/**
 * Communicator API level: the protocol level of the wrapper <-> server
 * conversation, independent of the cxx release number.
 *
 * - `COMMUNICATOR_API_VERSION` is the level this server speaks (bump it when the
 *   wrapper-visible contract changes in a way a newer client may rely on).
 * - `COMMUNICATOR_MIN_API` is the code-default floor: a client below it is too
 *   old to be served well and updates itself immediately.
 * - An operator can raise the floor at runtime without a deploy through the
 *   `versions` K/V row `communicator_min_api`. The effective floor is
 *   `max(code default, stored override)` and is never above the current level,
 *   so a bad row can never strand the fleet below an unreachable minimum.
 *
 * The server never rejects or blocks a client for being below the minimum; it
 * only advertises `api_version` / `min_api` and the client acts on them. See
 * `docs/communicator.md` (API level) and `docs/interface-api.md`.
 */

export const COMMUNICATOR_API_VERSION = 1;
export const COMMUNICATOR_MIN_API = 1;
/** `versions` row holding the operator override of the minimum. */
export const COMMUNICATOR_MIN_API_KEY = 'communicator_min_api';
/** Request header carrying the calling client's own level. */
export const COMMUNICATOR_API_HEADER = 'x-cxx-api';

export interface CommunicatorApiLevels {
  /** Current level this server speaks. */
  api_version: number;
  /** Effective minimum: max(code default, stored override), clamped to api_version. */
  min_api: number;
}

const MAX_CLIENT_LEVEL = 1_000_000;

/** Parses a stored/override value; anything that is not a positive integer is "no override". */
export function parseStoredMinApi(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!/^[0-9]{1,9}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Effective levels for a stored override (null/garbage means the code default). */
export function communicatorApiLevels(
  storedMin?: string | null,
  current = COMMUNICATOR_API_VERSION,
  defaultMin = COMMUNICATOR_MIN_API,
): CommunicatorApiLevels {
  const stored = parseStoredMinApi(storedMin);
  const min = Math.min(current, Math.max(defaultMin, stored ?? 0));
  return { api_version: current, min_api: min };
}

/** Reads the levels through anything that can fetch a `versions` row. */
export async function readCommunicatorApiLevels(source: {
  getRaw(key: string): Promise<string | null>;
}): Promise<CommunicatorApiLevels> {
  return communicatorApiLevels(await source.getRaw(COMMUNICATOR_MIN_API_KEY));
}

/**
 * A client-reported level: a positive integer within sane bounds, else null.
 * Accepts a number (handshake body) or a decimal string (header).
 */
export function parseClientApiLevel(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^[0-9]{1,7}$/.test(raw.trim())) n = Number(raw.trim());
  else return null;
  return Number.isInteger(n) && n >= 1 && n <= MAX_CLIENT_LEVEL ? n : null;
}

/** Validates an operator-supplied minimum; throws a message suitable for a 400. */
export function validateMinApiInput(
  value: unknown,
  current = COMMUNICATOR_API_VERSION,
  defaultMin = COMMUNICATOR_MIN_API,
): number {
  const n = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new RangeError('min_api must be an integer');
  }
  if (n < defaultMin || n > current) {
    throw new RangeError(`min_api must be between ${defaultMin} and ${current}`);
  }
  return n;
}

export interface ApiLevelCounts {
  /** Entries counted (hosts, or live communicator connections). */
  observed: number;
  below_min: number;
  /** Below the current level (includes those below the minimum). */
  below_current: number;
  at_current: number;
  /** Hosts seen without ever stating a level (clients that predate the contract). */
  unreported: number;
}

/** Tallies levels (null = unstated) against the effective floor and current level. */
export function tallyApiLevels(
  observed: Iterable<number | null | undefined>,
  levels: CommunicatorApiLevels,
): ApiLevelCounts {
  const out: ApiLevelCounts = { observed: 0, below_min: 0, below_current: 0, at_current: 0, unreported: 0 };
  for (const level of observed) {
    out.observed++;
    if (level == null) out.unreported++;
    else if (level < levels.min_api) {
      out.below_min++;
      out.below_current++;
    } else if (level < levels.api_version) out.below_current++;
    else out.at_current++;
  }
  return out;
}

interface HostObservation {
  levels: Map<number, number>;
  lastSeen: number;
}

/**
 * Process-local record of the levels clients state. Nothing here is persisted:
 * a restart empties it and the fleet refills it within one poll interval, the
 * same property the communicator connection registry has. A host's level is the
 * lowest level it stated inside the window, so one stale cdx next to a current
 * clx keeps the host flagged until the stale binary stops calling.
 */
export class ApiLevelTracker {
  private readonly hosts = new Map<number, HostObservation>();

  constructor(
    private readonly windowMs = 6 * 60 * 60 * 1000,
    private readonly maxHosts = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a request from `hostId`. `level` null means "stated nothing". */
  observe(hostId: number, level: number | null): void {
    const at = this.now();
    let entry = this.hosts.get(hostId);
    if (!entry) {
      if (this.hosts.size >= this.maxHosts) this.prune(at);
      if (this.hosts.size >= this.maxHosts) return;
      entry = { levels: new Map(), lastSeen: at };
      this.hosts.set(hostId, entry);
    }
    entry.lastSeen = at;
    if (level === null) return;
    if (entry.levels.size >= 8 && !entry.levels.has(level)) this.pruneLevels(entry, at);
    if (entry.levels.size < 8 || entry.levels.has(level)) entry.levels.set(level, at);
  }

  forget(hostId: number): void {
    this.hosts.delete(hostId);
  }

  /** Lowest in-window level for a host, or null when none was stated. */
  levelOf(hostId: number): number | null {
    const entry = this.hosts.get(hostId);
    if (!entry) return null;
    this.pruneLevels(entry, this.now());
    let low: number | null = null;
    for (const level of entry.levels.keys()) if (low === null || level < low) low = level;
    return low;
  }

  counts(levels: CommunicatorApiLevels): ApiLevelCounts {
    this.prune(this.now());
    return tallyApiLevels([...this.hosts.keys()].map((hostId) => this.levelOf(hostId)), levels);
  }

  /** Test seam / admin diagnostics: host id to its lowest in-window level. */
  entries(): Array<{ host_id: number; api_version: number | null; last_seen_ms: number }> {
    this.prune(this.now());
    return [...this.hosts].map(([host_id, entry]) => ({
      host_id,
      api_version: this.levelOf(host_id),
      last_seen_ms: entry.lastSeen,
    }));
  }

  clear(): void {
    this.hosts.clear();
  }

  private pruneLevels(entry: HostObservation, at: number): void {
    for (const [level, seen] of entry.levels) if (at - seen > this.windowMs) entry.levels.delete(level);
  }

  private prune(at: number): void {
    for (const [hostId, entry] of this.hosts) {
      if (at - entry.lastSeen > this.windowMs) this.hosts.delete(hostId);
      else this.pruneLevels(entry, at);
    }
  }
}

export const apiLevelTracker = new ApiLevelTracker();

/** Feeds the tracker from an authenticated host request's headers. Never throws. */
export function observeRequestApiLevel(
  hostId: number | undefined,
  headers: Record<string, string | string[] | undefined>,
): void {
  if (hostId === undefined) return;
  try {
    apiLevelTracker.observe(hostId, parseClientApiLevel(headers[COMMUNICATOR_API_HEADER]));
  } catch {
    /* Observation is diagnostics; it must never fail a request. */
  }
}

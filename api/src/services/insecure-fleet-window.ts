/**
 * The fleet-wide insecure access window — "let every insecure host through
 * until this evening".
 *
 * The per-host window (`insecure-window.ts`) is a sliding ten-minute grant,
 * which is right for an unattended fleet and wrong for a working day: an
 * operator at their desk otherwise babysits the approval popup or marks hosts
 * secure, which is worse. This is the switch that says "I am here, let them
 * all through", with a deadline and an off.
 *
 * ## Where the state lives
 *
 * One `versions` row, `insecure_fleet_window_until`, holding an absolute ISO
 * deadline. Absolute rather than a minute count on purpose: `clampWindow` in
 * insecure-window.ts caps minutes at 480, so a duration routed through the
 * per-host machinery would silently truncate anything past eight hours.
 *
 *   key absent           → closed
 *   value in the future  → open
 *   value in the past    → lapsed; the close still owes its work
 *
 * The key is therefore also the retry token. Closing runs
 * `sweep hosts → write audit → compare-and-delete the key`, in that order, so a
 * crash anywhere leaves the key behind and the next worker tick redoes the
 * sweep. Deleting first would be the tempting inversion and is wrong: it
 * discards the token and can leave the fleet open indefinitely.
 *
 * ## Why the grant is written onto host rows
 *
 * Opening stamps `insecure_enabled_until` on every insecure host rather than
 * adding a parallel check at each gate. `insecureWindowActive()` is a
 * synchronous predicate over a projected row subset, and `messagingHostEligible`
 * has a SQL twin (`messagingHostEligibleSql`) that is composed into queries
 * MySQL executes — neither can consult a settings key. Denormalizing keeps all
 * of them correct with no signature change, at the honest cost that
 * `insecure_enabled_until` means "the effective grant, whatever opened it",
 * which is already true of the sliding, domain-allow and provisioning paths.
 */
import { and, eq, isNull, gt, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { hosts, insecureAuthRequests, insecureDomainAllows } from '../db/schema.js';
import { nowIso } from '../util/timestamp.js';
import type { SettingsService } from './settings.js';

export const INSECURE_FLEET_WINDOW_KEY = 'insecure_fleet_window_until';

export const MIN_FLEET_WINDOW_MINUTES = 5;
export const MAX_FLEET_WINDOW_MINUTES = 1440;
export const DEFAULT_FLEET_WINDOW_MINUTES = 480;

export function clampFleetWindowMinutes(value: number | null | undefined): number {
  const n =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : DEFAULT_FLEET_WINDOW_MINUTES;
  if (n < MIN_FLEET_WINDOW_MINUTES) return MIN_FLEET_WINDOW_MINUTES;
  if (n > MAX_FLEET_WINDOW_MINUTES) return MAX_FLEET_WINDOW_MINUTES;
  return n;
}

export interface FleetWindowState {
  /** The stored value verbatim — the token `deleteIf` compares against. */
  raw: string | null;
  until: Date | null;
  /** True while the deadline is in the future. */
  open: boolean;
  /** True when a deadline is stored but has passed: the close still owes work. */
  lapsed: boolean;
  openedAt: string | null;
}

function parseDeadline(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The read every gate uses. Deliberately non-mutating: `enforce()` runs this on
 * a hot auth path and must not be the thing that decides to sweep the fleet.
 */
export async function readFleetWindow(
  settings: SettingsService,
  now: Date = new Date(),
): Promise<FleetWindowState> {
  const { value, updatedAt } = await settings.getWithMeta(INSECURE_FLEET_WINDOW_KEY);
  const until = parseDeadline(value);
  if (!until) return { raw: value, until: null, open: false, lapsed: false, openedAt: null };
  const open = until.getTime() > now.getTime();
  return { raw: value, until, open, lapsed: !open, openedAt: updatedAt };
}

/**
 * Stamp the fleet deadline onto every insecure host.
 *
 * `insecure_window_minutes` is deliberately left alone: it is clamped to 480 and
 * is the host's own stored default, which a fleet window has no business
 * rewriting permanently. The grace tail is cleared rather than extended — the
 * fleet deadline is the whole of the grant, and a tail hanging past it would
 * outlive the window it belongs to.
 */
export async function stampAllInsecureHosts(
  db: Database,
  until: Date,
): Promise<Array<{ id: number; fqdn: string }>> {
  const nowStr = nowIso();
  const allHosts = await db.select().from(hosts);
  const stamped: Array<{ id: number; fqdn: string }> = [];
  for (const h of allHosts) {
    if (h.secure === 1) continue;
    await db
      .update(hosts)
      .set({ insecureEnabledUntil: until, insecureGraceUntil: null, updatedAt: nowStr })
      .where(eq(hosts.id, h.id));
    stamped.push({ id: Number(h.id), fqdn: h.fqdn });
  }
  return stamped;
}

export interface FleetCloseCounts {
  hosts: number;
  domains: number;
}

/**
 * Close every standing insecure grant: host windows, their grace tails, and any
 * active domain allow.
 *
 * The domain allows matter more than they look. `enforce()`'s domain branch is
 * reached exactly when a host's own window is shut — which is the state this
 * sweep just created — and it re-opens the host and slides the allow forward.
 * Leaving those rows alone would mean a closed fleet window that lets its hosts
 * back in on the next poll, so `enabled_until` is pulled back to now. The rows
 * survive with `revoked_at` still NULL, so an operator can re-arm one from the
 * approvals dialog; this is not a revoke.
 */
export async function closeAllInsecureAccess(
  db: Database,
  onHost?: (host: { id: number; fqdn: string }) => Promise<void> | void,
): Promise<FleetCloseCounts> {
  const nowMs = Date.now();
  const nowStr = nowIso();
  const allHosts = await db.select().from(hosts);
  let closedHosts = 0;
  for (const h of allHosts) {
    if (h.secure === 1) continue;
    const enabledUntilMs = h.insecureEnabledUntil ? new Date(h.insecureEnabledUntil).getTime() : 0;
    const graceUntilMs = h.insecureGraceUntil ? new Date(h.insecureGraceUntil).getTime() : 0;
    if (enabledUntilMs <= nowMs && graceUntilMs <= nowMs) continue;
    await db
      .update(hosts)
      .set({ insecureEnabledUntil: null, insecureGraceUntil: null, updatedAt: nowStr })
      .where(eq(hosts.id, h.id));
    closedHosts += 1;
    if (onHost) await onHost({ id: Number(h.id), fqdn: h.fqdn });
  }

  const allows = await db
    .select()
    .from(insecureDomainAllows)
    .where(
      and(
        isNull(insecureDomainAllows.revokedAt),
        or(
          isNull(insecureDomainAllows.enabledUntil),
          gt(insecureDomainAllows.enabledUntil, nowStr),
        ),
      ),
    );
  let closedDomains = 0;
  for (const allow of allows) {
    await db
      .update(insecureDomainAllows)
      .set({ enabledUntil: nowStr, updatedAt: nowStr })
      .where(eq(insecureDomainAllows.id, allow.id));
    closedDomains += 1;
  }

  return { hosts: closedHosts, domains: closedDomains };
}

/**
 * Resolve every pending approval as approved.
 *
 * Not routed through `InsecureWindowAdminService.approve()` on purpose: that
 * method expires anything older than the five-minute TTL and then throws
 * `ConflictError`, and `listPending()` re-runs the same expiry on every read.
 * A request that has been waiting six minutes when the operator opens the
 * window would be auto-denied rather than let in — the opposite of what opening
 * means. While the fleet window is open it supersedes the approval workflow, so
 * the rows are resolved directly.
 */
export async function approveAllPendingInsecureRequests(
  db: Database,
): Promise<Array<{ id: number; hostId: number }>> {
  const pending = await db
    .select({ id: insecureAuthRequests.id, hostId: insecureAuthRequests.hostId })
    .from(insecureAuthRequests)
    .where(eq(insecureAuthRequests.status, 'pending'));
  if (pending.length === 0) return [];
  const resolvedAt = nowIso();
  for (const row of pending) {
    await db
      .update(insecureAuthRequests)
      .set({ status: 'approved', resolvedAt, updatedAt: resolvedAt })
      .where(eq(insecureAuthRequests.id, row.id));
  }
  return pending;
}

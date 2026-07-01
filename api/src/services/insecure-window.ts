import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import {
  hosts as hostsTable,
  insecureAuthRequests,
  insecureDomainAllows,
  type Host,
} from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { ForbiddenError, LockedError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';

/**
 * Port of InsecureHostWindowService.php. Tracks per-host insecure access
 * windows with sliding extension on each hit, grace period after closure,
 * domain-allow auto-extension, and the optional approval workflow.
 *
 * Window contract:
 *   - stored window minutes are clamped to [0, 480]; the default (when none
 *     is set on the host row) is 10 minutes.
 *   - hitting a still-open window pushes both `enabled_until` and the grace
 *     tail forward.
 *   - `store` is allowed during the grace tail so a session's final upload
 *     succeeds after the window technically closes.
 *   - a matching `insecure_domain_allows` row opens the window automatically.
 */

const MIN_WINDOW = 0;
const MAX_WINDOW = 480;
const DEFAULT_WINDOW = 10;
const PROVISIONING_WINDOW_MINUTES = 30;
const APPROVAL_DENY_COOLDOWN_SECONDS = 60;

export type InsecureCommand = 'auth' | 'store' | 'retrieve' | 'mcp' | 'host_lane_get' | 'host_lane_set' | string;

export interface InsecureWindowService {
  /**
   * Ensures the host is currently allowed to make insecure-mode requests.
   * Mutates `insecure_enabled_until` to slide the window on a hit. Returns
   * the (possibly refreshed) host row.
   */
  enforce(host: Host, command: InsecureCommand): Promise<Host>;

  /**
   * Opens the initial 30-minute provisioning window for a freshly-registered
   * insecure host (or a custom window if the operator overrides).
   */
  openInitial(hostId: number, windowMinutes?: number): Promise<void>;
}

export interface InsecureWindowDeps {
  db: Database;
  env: Env;
}

export function createInsecureWindowService(deps: InsecureWindowDeps): InsecureWindowService {
  const { db, env } = deps;

  return {
    async enforce(host, command) {
      if (host.secure === 1) return host;

      const now = new Date();
      const enabledUntil = parseDate(host.insecureEnabledUntil ?? null);
      const graceUntil = parseDate(host.insecureGraceUntil ?? null);
      const enabledActive = enabledUntil !== null && enabledUntil >= now;
      const graceActive = graceUntil !== null && graceUntil >= now;
      const hostId = host.id;

      if (enabledActive) {
        const windowMinutes = clampWindow(host.insecureWindowMinutes ?? null);
        const newUntil = new Date(now.getTime() + windowMinutes * 60_000);
        const newGrace = computeGrace(newUntil, windowMinutes, env);
        await db
          .update(hostsTable)
          .set({
            insecureEnabledUntil: newUntil,
            insecureGraceUntil: newGrace,
            updatedAt: nowIso(),
          })
          .where(eq(hostsTable.id, hostId));
        return {
          ...host,
          insecureEnabledUntil: newUntil,
          insecureGraceUntil: newGrace,
        };
      }

      if (command === 'store' && graceActive) return host;

      const domainMatch = await findActiveDomainAllow(db, host.fqdn);
      if (domainMatch) {
        const windowMinutes = clampWindow(host.insecureWindowMinutes ?? null);
        const newUntil = new Date(now.getTime() + windowMinutes * 60_000);
        const newGrace = computeGrace(newUntil, windowMinutes, env);
        const domainMinutes = clampWindow(domainMatch.windowMinutes);
        const domainEnabledUntil = new Date(now.getTime() + domainMinutes * 60_000);
        await db
          .update(hostsTable)
          .set({
            insecureEnabledUntil: newUntil,
            insecureGraceUntil: newGrace,
            updatedAt: nowIso(),
          })
          .where(eq(hostsTable.id, hostId));
        await db
          .update(insecureDomainAllows)
          .set({ enabledUntil: isoLocalAtom(domainEnabledUntil), updatedAt: nowIso() })
          .where(eq(insecureDomainAllows.id, domainMatch.id));
        wsPublisher.publish('insecure.domain.allowed', {
          host_id: hostId,
          fqdn: host.fqdn,
          domain: domainMatch.domain,
        });
        return {
          ...host,
          insecureEnabledUntil: newUntil,
          insecureGraceUntil: newGrace,
        };
      }

      const pending = await db
        .select()
        .from(insecureAuthRequests)
        .where(
          and(eq(insecureAuthRequests.hostId, hostId), eq(insecureAuthRequests.status, 'pending')),
        )
        .limit(1);
      if (pending[0]) {
        throw new LockedError('Insecure host approval pending', 'insecure_pending');
      }

      const latest = await db
        .select()
        .from(insecureAuthRequests)
        .where(eq(insecureAuthRequests.hostId, hostId))
        .orderBy(desc(insecureAuthRequests.requestedAt))
        .limit(1);
      const latestRow = latest[0];
      if (latestRow && latestRow.status === 'denied' && latestRow.resolvedAt) {
        const resolved = parseDate(latestRow.resolvedAt);
        if (resolved && now.getTime() - resolved.getTime() < APPROVAL_DENY_COOLDOWN_SECONDS * 1000) {
          throw new ForbiddenError('Insecure host approval denied', 'insecure_denied');
        }
      }

      const requestedAt = nowIso();
      try {
        await db.insert(insecureAuthRequests).values({
          hostId,
          status: 'pending',
          requestedAt,
          updatedAt: requestedAt,
        });
        wsPublisher.publish('insecure.requested', {
          host_id: hostId,
          fqdn: host.fqdn,
          command,
        });
      } catch {
        // table may already have a unique constraint; ignore — we still 423.
      }
      throw new LockedError('Insecure host approval pending', 'insecure_pending');
    },

    async openInitial(hostId, windowMinutes) {
      const initialMinutes =
        windowMinutes !== undefined ? clampWindow(windowMinutes) : PROVISIONING_WINDOW_MINUTES;
      const storedMinutes =
        windowMinutes !== undefined ? clampWindow(windowMinutes) : DEFAULT_WINDOW;
      const enabledUntil = new Date(Date.now() + initialMinutes * 60_000);
      const grace = computeGrace(enabledUntil, storedMinutes, env);
      await db
        .update(hostsTable)
        .set({
          insecureEnabledUntil: enabledUntil,
          insecureGraceUntil: grace,
          insecureWindowMinutes: storedMinutes,
          updatedAt: nowIso(),
        })
        .where(eq(hostsTable.id, hostId));
    },
  };
}

function clampWindow(v: number | null | undefined): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_WINDOW;
  if (n < MIN_WINDOW) return MIN_WINDOW;
  if (n > MAX_WINDOW) return MAX_WINDOW;
  return n;
}

function computeGrace(enabledUntil: Date, windowMinutes: number, env: Env): Date | null {
  if (windowMinutes <= 0) return null;
  const graceMinutes = env.INSECURE_GRACE_MINUTES ?? 60;
  if (graceMinutes <= 0) return null;
  return new Date(enabledUntil.getTime() + graceMinutes * 60_000);
}

function parseDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoLocalAtom(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function findActiveDomainAllow(
  db: Database,
  fqdn: string | null,
): Promise<{ id: number; windowMinutes: number; domain: string } | null> {
  if (!fqdn) return null;
  const f = fqdn.toLowerCase();
  const nowStr = nowIso();
  const rows = await db
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
  for (const r of rows) {
    const domain = r.domain.toLowerCase();
    if (!domain) continue;
    if (f === domain) return { id: r.id, windowMinutes: r.windowMinutes, domain };
    const suffix = '.' + domain;
    if (f.endsWith(suffix) && f.length > suffix.length) {
      return { id: r.id, windowMinutes: r.windowMinutes, domain };
    }
  }
  return null;
}

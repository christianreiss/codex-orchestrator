import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import {
  hosts as hostsTable,
  insecureAuthRequests,
  insecureDomainAllows,
  type Host,
} from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { readFleetWindow } from './insecure-fleet-window.js';
import { SettingsService } from './settings.js';
import { ForbiddenError, LockedError } from '../http/errors.js';
import { isoOffsetSeconds, nowIso } from '../util/timestamp.js';
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
 *   - `store` is always admitted as a candidate after normal API-key, host,
 *     IP, and reverse-DNS authentication. It neither requires nor extends the
 *     retrieve window; runner validation still gates canonical persistence.
 *   - a matching `insecure_domain_allows` row opens the window automatically.
 *   - an open fleet window (`insecure-fleet-window.ts`) admits every insecure
 *     host and is checked before all of the above, so nothing below can shorten
 *     the fleet deadline or turn it into an approval prompt.
 */

const MIN_WINDOW = 0;
const MAX_WINDOW = 480;
const DEFAULT_WINDOW = 10;
const PROVISIONING_WINDOW_MINUTES = 30;
const APPROVAL_DENY_COOLDOWN_SECONDS = 60;
const PENDING_APPROVAL_TTL_MS = 5 * 60_000;

export type InsecureCommand = 'auth' | 'store' | 'retrieve' | 'mcp' | 'host_lane_get' | 'host_lane_set' | string;

/**
 * True while the host's allowed window is open. This is the read-only view of
 * the window: unlike `enforce`, it neither slides `insecure_enabled_until` nor
 * opens an approval request, so a polling caller cannot hold its own window
 * open forever. Callers that authorize per operation (Agent Messaging) use
 * this; callers that represent real host traffic use `enforce`.
 *
 * The window is `insecure_enabled_until` only. `insecure_grace_until` is a
 * separate tail used by the auth lane and does not grant access here.
 */
export function insecureWindowActive(host: Pick<Host, 'insecureEnabledUntil'>): boolean {
  const until = host.insecureEnabledUntil;
  if (!until) return false;
  const ms = until instanceof Date ? until.getTime() : new Date(until).getTime();
  return Number.isFinite(ms) && ms >= Date.now();
}

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
  // `SettingsService` needs only a `Database`, so the fleet window is reachable
  // from here without changing any of the five construction sites.
  const settings = new SettingsService(db);

  return {
    async enforce(host, command) {
      if (host.secure === 1) return host;

      // A local login/logout may complete after the retrieve window closes.
      // Rejecting its final store strands the fresh generation on one host and
      // lets an older canonical win later. Authentication and runner checks
      // still apply; only the insecure retrieve-window gate is bypassed.
      if (command === 'store') return host;

      const now = new Date();

      // The fleet window, checked before anything else.
      //
      // Placing it first is what makes "auto-allow all" true rather than
      // approximately true. Everything below writes
      // `now + clampWindow(host.insecureWindowMinutes)` with no ceiling — the
      // ordinary slide, and the domain-allow branch independently — so an
      // 8-hour fleet grant would collapse to this host's stored default (10
      // minutes, or 0 for a host whose window is set to zero) on its very next
      // request. Coming first also means a host with no window at all is
      // admitted instead of opening an approval request, and that the
      // 60-second deny cooldown cannot punch a hole in an open window.
      const fleet = await readFleetWindow(settings, now);
      if (fleet.open && fleet.until) {
        const current = parseDate(host.insecureEnabledUntil ?? null);
        if (!current || current.getTime() < fleet.until.getTime()) {
          await db
            .update(hostsTable)
            .set({
              insecureEnabledUntil: fleet.until,
              insecureGraceUntil: null,
              updatedAt: nowIso(),
            })
            .where(eq(hostsTable.id, host.id));
          return { ...host, insecureEnabledUntil: fleet.until, insecureGraceUntil: null };
        }
        return host;
      }

      const enabledUntil = parseDate(host.insecureEnabledUntil ?? null);
      const enabledActive = enabledUntil !== null && enabledUntil >= now;
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
        const requested = parseDate(pending[0].requestedAt);
        if (requested && now.getTime() - requested.getTime() >= PENDING_APPROVAL_TTL_MS) {
          const resolvedAt = nowIso();
          await db
            .update(insecureAuthRequests)
            .set({ status: 'denied', resolvedAt, updatedAt: resolvedAt })
            .where(eq(insecureAuthRequests.id, pending[0].id));
          wsPublisher.publish('insecure.denied', {
            host_id: hostId,
            fqdn: host.fqdn,
            request_id: pending[0].id,
            reason: 'timeout',
          });
          throw new ForbiddenError('Insecure host approval denied', 'insecure_denied');
        }
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
  return isoOffsetSeconds(0, d);
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

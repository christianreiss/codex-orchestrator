import type { OwnerStateSnapshot } from '../control-plane/state/store.js';
import {persistAuditLog} from './audit-log.js';
import { admissionInterestAt, pendingWithInterest } from '../control-plane/state/admission-interest.js';
import { mutateOwnerState, ownerRuntimeFor, type OwnerMutationContext } from '../control-plane/state/runtime.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { adminAudit } from '../control-plane/state/admin.js';
import type { ManagedHost as Host } from '../control-plane/state/host-registration.js';
import type { Json } from '../control-plane/commands.js';
/**
 * Admin-facing wrapper around the insecure window state machine.
 *
 * Mirrors the legacy AdminHostController insecure* methods and the relevant
 * subset of InsecureHostWindowService:
 *   - enable/disable insecure window on a single host
 *   - list/approve/deny/allow-domain on insecure_auth_requests
 *   - revoke an insecure_domain_allows row
 *
 * Each mutation writes the audit row + publishes the matching WS event in
 * that order.
 */
import { visibleHost } from './internal-hosts.js';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import {
  hosts,
  insecureAuthRequests,
  insecureDomainAllows,
  versions,
} from '../db/schema.js';
import { isoOffsetSeconds, nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { NotFoundError, ValidationError, ConflictError } from '../http/errors.js';
import type { AdminEventsWriter } from './admin-events-writer.js';
import {
  clampInsecureMinutes,
  computeGraceUntil,
  DEFAULT_INSECURE_WINDOW_MINUTES,
  MAX_INSECURE_WINDOW_MINUTES,
} from './host-management.js';
import { SettingsService } from './settings.js';
import {
  approveAllPendingInsecureRequests,
  clampFleetWindowMinutes,
  closeAllInsecureAccess,
  INSECURE_FLEET_WINDOW_KEY,
  readFleetWindow,
  stampAllInsecureHosts,
  type FleetWindowState,
} from './insecure-fleet-window.js';
import {
  insecureWindowActive,
  PENDING_APPROVAL_TTL_MS,
  stalePendingReason,
} from './insecure-window.js';

/**
 * Why the sweep retired a pending request. `superseded` is the one the
 * request's own timestamps cannot tell: the host was deleted, made secure, or
 * already let in some other way, so there is nothing left to decide.
 */
type RetireReason = 'timeout' | 'abandoned' | 'superseded';


/**
 * What an operator approval is worth: eight hours, the same grant the fleet
 * window hands out by default.
 *
 * Deliberately not the host's stored `insecure_window_minutes` (10 by default).
 * That number is the *sliding* window for unattended traffic — a host that keeps
 * talking keeps itself open ten minutes at a time. An approval is a different
 * act: a human looked at the request and said yes, and making them look again
 * ten minutes later is the behaviour that drove operators to open the fleet
 * window instead. `approve()` and `allowDomain()` also write this onto
 * `insecure_window_minutes`, so the subsequent slides in `enforce()` are eight
 * hours too rather than collapsing back to ten minutes on the next request.
 */
const APPROVAL_WINDOW_MINUTES = MAX_INSECURE_WINDOW_MINUTES;

/** Cap on how many sibling requests one domain allow resolves in a sweep. */
const DOMAIN_SWEEP_LIMIT = 200;

/** True when `fqdn` is `domain` itself or a subdomain of it. */
function fqdnMatchesDomain(fqdn: string | null | undefined, domain: string): boolean {
  if (typeof fqdn !== 'string') return false;
  const f = fqdn.toLowerCase().trim();
  if (!f) return false;
  if (f === domain) return true;
  const suffix = `.${domain}`;
  return f.endsWith(suffix) && f.length > suffix.length;
}

export interface InsecureWindowAdminOptions {
  db: Database;
  env: Env;
  events: AdminEventsWriter;
}

export interface InsecureRequestRow {
  id: number;
  host_id: number;
  fqdn: string;
  request_ip: string | null;
  requested_at: string;
  resolved_at: string | null;
  updated_at: string;
  status: string;
  /** When the request auto-denies if nobody answers it. */
  expires_at: string | null;
  /**
   * True once the requesting wrapper has polled again after opening it, i.e.
   * a human is parked on the approval box. One-shot headless calls stay false.
   */
  live: boolean;
}

export interface InsecureDomainAllowRow {
  id: number;
  domain: string;
  window_minutes: number;
  enabled_until: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsecureWindowActor {
  admin_user_id: number;
  device_id: string;
}

export interface ActiveInsecureWindow {
  host_id: number;
  fqdn: string;
  enabled_until: string;
  /** An independent domain grant may reopen this host after disabling it. */
  domain_allow: string | null;
}

function parseDate(s: string | Date | null | undefined): Date | null {
  if (!s) return null;
  if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function expiresAt(requestedAt: string): string | null {
  const requested = parseDate(requestedAt);
  if (!requested) return null;
  return isoOffsetSeconds(PENDING_APPROVAL_TTL_MS / 1000, requested);
}

function normalizeDomainCandidate(domain: string | null | undefined): string | null {
  if (typeof domain !== 'string') return null;
  let normalized = domain.toLowerCase().trim();
  if (!normalized) return null;
  if (normalized.startsWith('*.')) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\.+|\.+$/g, '');
  if (!normalized || !normalized.includes('.')) return null;
  if (/\s/.test(normalized)) return null;
  if (normalized.includes('..')) return null;
  return normalized;
}

function resolveParentDomain(fqdn: string | null | undefined): string | null {
  if (typeof fqdn !== 'string') return null;
  const trimmed = fqdn.toLowerCase().trim();
  if (!trimmed) return null;
  const parts = trimmed.split('.').filter((p) => p !== '');
  if (parts.length < 3) return null;
  return normalizeDomainCandidate(parts.slice(1).join('.'));
}

export class InsecureWindowAdminService {
  constructor(private readonly opts: InsecureWindowAdminOptions) {}

  private get db(): Database {
    return this.opts.db;
  }
  private get env(): Env {
    return this.opts.env;
  }
  private get events(): AdminEventsWriter {
    return this.opts.events;
  }

  private get settings(): SettingsService {
    this.settingsCache ??= new SettingsService(this.opts.db);
    return this.settingsCache;
  }
  private settingsCache: SettingsService | undefined;

  private async owned<T>(kind: string, payload: Record<string, unknown>, prepare: (ctx: OwnerMutationContext, publish: (type: string, payload: Record<string, unknown>) => void) => T, authorize?: (snapshot: OwnerStateSnapshot) => void): Promise<T> {
    const owner = ownerRuntimeFor(this.db)!;
    let result!: T; const events: Array<() => void> = [];
    await mutateOwnerState(owner, { kind, authorize, payload: JSON.parse(JSON.stringify(payload)) as Json, prepare(ctx) {
      result = prepare(ctx, (type, payload) => events.push(() => wsPublisher.publish(type, payload)));
      return () => JSON.parse(JSON.stringify(result ?? null)) as Json;
    } });
    for (const event of events) event();
    return result;
  }

  private ownedLog(ctx: OwnerMutationContext, hostId: number | null, action: string, details: Record<string, unknown>): void {
    ctx.write(async tx => persistAuditLog(tx, { hostId, action, details: JSON.stringify(details), createdAt: nowIso() }));
  }

  private ownedGrant(ctx: OwnerMutationContext, host: Host, minutes: number): Date {
    const now = Date.now(); const current = parseDate(host.insecureEnabledUntil)?.getTime() ?? 0;
    const until = new Date(Math.max(current, now) + minutes * 60_000);
    stageUpdate(ctx, 'hosts', host.id, { insecureEnabledUntil: until, insecureSessionRenewalBlocked: 0, insecureGraceUntil: computeGraceUntil(until, minutes, clampInsecureMinutes(this.env.INSECURE_GRACE_MINUTES, 60)), insecureWindowMinutes: minutes, updatedAt: nowIso() });
    return until;
  }

  private async writeLog(
    hostId: number | null,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await persistAuditLog(this.db, {
      hostId: hostId ?? null,
      action,
      details: Object.keys(details).length ? JSON.stringify(details) : null,
      createdAt: nowIso(),
    });
  }

  private async findHost(id: number): Promise<Host> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) { owner.assertOwner(); const host = owner.state.snapshot().hosts.get(id); if (!host) throw new NotFoundError('Host not found'); return host; }
    const rows = await this.db.select().from(hosts).where(eq(hosts.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundError('Host not found');
    return rows[0];
  }

  /**
   * Open (or extend) one host's window by `minutes` and write the audit row.
   *
   * Extracted so the single-host approval and the domain sweep stamp hosts
   * identically: the same additive base (an already-open window is extended,
   * not truncated), the same grace tail, and the same stored window minutes.
   */
  private async stampHostWindow(
    host: Host,
    minutes: number,
    source: 'approval' | 'approval_domain',
    requestId: number,
  ): Promise<Date> {
    const now = Date.now();
    const currentEnabled = parseDate(host.insecureEnabledUntil);
    const baseMs = currentEnabled && currentEnabled.getTime() > now ? currentEnabled.getTime() : now;
    const enabledUntil = new Date(baseMs + minutes * 60_000);
    const graceMinutes = clampInsecureMinutes(this.env.INSECURE_GRACE_MINUTES, 60);
    const grace = computeGraceUntil(enabledUntil, minutes, graceMinutes);

    await this.db
      .update(hosts)
      .set({
        insecureEnabledUntil: enabledUntil,
        insecureSessionRenewalBlocked: 0,
        insecureGraceUntil: grace,
        insecureWindowMinutes: minutes,
        updatedAt: nowIso(),
      })
      .where(eq(hosts.id, host.id));

    await this.writeLog(host.id, 'admin.host.insecure_enable', {
      fqdn: host.fqdn,
      enabled_until: enabledUntil.toISOString(),
      window_minutes: minutes,
      source,
      request_id: requestId,
    });
    return enabledUntil;
  }

  /**
   * Retire one pending request that no longer deserves a decision.
   *
   * A timeout is recorded as `denied` — the historical outcome, and the one
   * that starts the deny cooldown. Everything else is `expired`: nobody said
   * no, so a host that asks again must not be turned away for a minute.
   */
  private async retirePendingRequest(
    req: { id: number; hostId: number },
    reason: RetireReason,
    host: Host | null,
  ): Promise<void> {
    const resolvedAt = nowIso();
    await this.db
      .update(insecureAuthRequests)
      .set({ status: reason === 'timeout' ? 'denied' : 'expired', resolvedAt, updatedAt: resolvedAt })
      .where(and(eq(insecureAuthRequests.id, req.id), eq(insecureAuthRequests.status, 'pending')));

    await this.writeLog(host?.id ?? req.hostId, 'admin.insecure.auto_denied', {
      fqdn: host?.fqdn ?? null,
      request_id: req.id,
      reason,
      ...(reason === 'timeout' ? { ttl_seconds: PENDING_APPROVAL_TTL_MS / 1000 } : {}),
    });
    await this.events.appendAndPublish(
      'insecure.denied',
      { host_id: req.hostId, fqdn: host?.fqdn ?? null, request_id: req.id, reason },
      {
        hostId: req.hostId,
        wsType: 'insecure.denied',
        wsPayload: { host_id: req.hostId, request_id: req.id, reason },
      },
    );
  }

  /**
   * Retire `req` if it is stale; true when it was.
   *
   * `superseded` is only judged by the sweep. The approve/deny/allow guards
   * leave it out so an action on a secure or deleted host still fails with the
   * error that names the actual problem.
   */
  private async expirePendingRequest(
    req: {
      id: number;
      hostId: number;
      status: string;
      requestedAt: string;
      updatedAt: string;
    },
    includeSuperseded = false,
  ): Promise<boolean> {
    if (req.status !== 'pending') return false;
    let reason: RetireReason | null = stalePendingReason(req);
    if (!reason && !includeSuperseded) return false;
    const host = await this.findHost(req.hostId).catch(() => null);
    if (!reason && (!host || host.secure === 1 || insecureWindowActive(host))) {
      reason = 'superseded';
    }
    if (!reason) return false;
    await this.retirePendingRequest(req, reason, host);
    return true;
  }

  /**
   * Retire every pending request nobody should be asked about any more.
   *
   * Called on read by `listPending` and on a timer by the insecure worker —
   * the timer is what makes a request left open in an unattended dashboard
   * disappear, since nothing else reads it.
   */
  async sweepStaleRequests(): Promise<number> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      const stale = owner.state.snapshot().table('insecureAuthRequests').by('status', 'pending').some(req => {
        const host = owner.state.snapshot().hosts.get(req.hostId);
        return stalePendingReason(pendingWithInterest(owner, req)) || !host || host.secure === 1 || insecureWindowActive(host);
      });
      if (!stale) return 0;
      return this.owned('insecure.requests.expire', {}, (ctx, publish) => {
        let count = 0;
        for (const req of ctx.draft.table('insecureAuthRequests').by('status', 'pending')) {
          const host = ctx.draft.table('hosts').get(req.hostId);
          const reason = stalePendingReason(pendingWithInterest(owner, req)) ?? (!host || host.secure === 1 || insecureWindowActive(host) ? 'superseded' : null);
          if (!reason) continue;
          stageUpdate(ctx, 'insecureAuthRequests', req.id, { status: reason === 'timeout' ? 'denied' : 'expired', resolvedAt: nowIso(), updatedAt: nowIso() });
          const details = { host_id: req.hostId, fqdn: host?.fqdn ?? null, request_id: req.id, reason };
          this.ownedLog(ctx, req.hostId, 'admin.insecure.auto_denied', { ...details, ...(reason === 'timeout' ? { ttl_seconds: PENDING_APPROVAL_TTL_MS / 1000 } : {}) });
          adminAudit(ctx, 'insecure.denied', details, nowIso(), req.hostId); publish('insecure.denied', details); count++;
        }
        return count;
      });
    }
    const rows = await this.db
      .select()
      .from(insecureAuthRequests)
      .where(eq(insecureAuthRequests.status, 'pending'));
    let retired = 0;
    for (const req of rows) {
      if (await this.expirePendingRequest(req, true)) retired += 1;
    }
    return retired;
  }

  // ────────── fleet-wide window ──────────

  /** Read-only view of the fleet window, for the admin summary and the UI. */
  async fleetWindowState(): Promise<FleetWindowState> {
    return readFleetWindow(this.settings);
  }

  /** Safe access projection; independent of daemon availability or engine. */
  async accessWindows(): Promise<{
    active_windows: ActiveInsecureWindow[];
    fleet_window: { open: boolean; enabled_until: string | null };
  }> {
    const now = Date.now();
    const [allHosts, domains, fleet] = await Promise.all([
      ownerRuntimeFor(this.db) ? Promise.resolve(ownerRuntimeFor(this.db)!.state.snapshot().hosts.all().filter(host => !host.internalRole)) : this.db.select({ id: hosts.id, fqdn: hosts.fqdn, secure: hosts.secure, insecureEnabledUntil: hosts.insecureEnabledUntil }).from(hosts).where(visibleHost),
      ownerRuntimeFor(this.db) ? Promise.resolve(ownerRuntimeFor(this.db)!.state.snapshot().table('insecureDomainAllows').all()) : this.db.select().from(insecureDomainAllows),
      this.fleetWindowState(),
    ]);
    const activeDomains = domains.filter((d) => d.revokedAt === null &&
      (d.enabledUntil === null || (parseDate(d.enabledUntil)?.getTime() ?? 0) > now));
    const active_windows = allHosts.flatMap((h) => {
      const until = parseDate(h.insecureEnabledUntil);
      if (h.secure === 1 || !until || until.getTime() <= now) return [];
      return [{
        host_id: Number(h.id), fqdn: h.fqdn, enabled_until: until.toISOString(),
        domain_allow: activeDomains.find((d) => fqdnMatchesDomain(h.fqdn, d.domain))?.domain ?? null,
      }];
    }).sort((a, b) => a.fqdn.localeCompare(b.fqdn) || a.host_id - b.host_id);
    return { active_windows, fleet_window: { open: fleet.open, enabled_until: fleet.until?.toISOString() ?? null } };
  }

  /**
   * Open (or re-set) the fleet window for `durationMinutes`.
   *
   * Re-opening replaces the deadline rather than adding to it, unlike the
   * per-host `enable()` which is deliberately additive: "until 17:00" has to
   * keep meaning 17:00 however many times an operator presses the button.
   */
  async openFleetWindow(durationMinutes: number | null): Promise<{
    until: Date;
    windowMinutes: number;
    hostsOpened: number;
    approvalsResolved: number;
  }> {
    const minutes = clampFleetWindowMinutes(durationMinutes ?? undefined);
    const raw = isoOffsetSeconds(minutes * 60);
    const until = new Date(raw);
    if (ownerRuntimeFor(this.db)) return this.owned('insecure.fleet.open', { minutes }, (ctx, publish) => {
      const at = nowIso(); const version = { name: INSECURE_FLEET_WINDOW_KEY, version: raw, updatedAt: at };
      ctx.draft.upsert('versions', version);
      ctx.write(async tx => tx.insert(versions).values(version).onDuplicateKeyUpdate({ set: { version: raw, updatedAt: at } }));
      let hostsOpened = 0; const approved: number[] = [];
      for (const host of ctx.draft.table('hosts').all()) {
        if (host.secure === 1) continue;
        stageUpdate(ctx, 'hosts', host.id, { insecureEnabledUntil: until, insecureGraceUntil: null, insecureSessionRenewalBlocked: 0, updatedAt: at });
        publish('host.updated', { id: host.id }); hostsOpened++;
      }
      for (const req of ctx.draft.table('insecureAuthRequests').by('status', 'pending')) {
        stageUpdate(ctx, 'insecureAuthRequests', req.id, { status: 'approved', resolvedAt: at, updatedAt: at }); approved.push(req.id);
        this.ownedLog(ctx, req.hostId, 'admin.insecure.approval', { request_id: req.id, source: 'fleet_window' });
      }
      const details = { action: 'fleet_window_opened', enabled_until: raw, window_minutes: minutes, hosts_opened: hostsOpened, approvals_resolved: approved.length, cleared_request_ids: approved };
      this.ownedLog(ctx, null, 'admin.insecure.fleet_window_open', details); adminAudit(ctx, 'insecure.approval.changed', details);
      publish('insecure.approval.changed', { source: 'fleet_window_opened', enabled_until: raw, cleared_request_ids: approved });
      return { until, windowMinutes: minutes, hostsOpened, approvalsResolved: approved.length };
    });

    await this.settings.set(INSECURE_FLEET_WINDOW_KEY, raw);
    const stamped = await stampAllInsecureHosts(this.db, until);
    const approved = await approveAllPendingInsecureRequests(this.db);

    await this.writeLog(null, 'admin.insecure.fleet_window_open', {
      enabled_until: raw,
      window_minutes: minutes,
      hosts_opened: stamped.length,
      approvals_resolved: approved.length,
    });
    for (const req of approved) {
      await this.writeLog(req.hostId, 'admin.insecure.approval', {
        request_id: req.id,
        source: 'fleet_window',
      });
    }
    for (const host of stamped) {
      wsPublisher.publish('host.updated', { id: host.id });
    }

    await this.events.appendAndPublish(
      'insecure.approval.changed',
      {
        action: 'fleet_window_opened',
        enabled_until: raw,
        window_minutes: minutes,
        hosts_opened: stamped.length,
        approvals_resolved: approved.length,
        cleared_request_ids: approved.map((r) => r.id),
      },
      {
        wsType: 'insecure.approval.changed',
        wsPayload: {
          source: 'fleet_window_opened',
          enabled_until: raw,
          // Which rows the open just resolved. Clients hold a pending list they
          // cannot otherwise reconcile: the rows simply stop coming back from
          // /pending, with nothing saying they were allowed rather than denied.
          cleared_request_ids: approved.map((r) => r.id),
        },
      },
    );

    return {
      until,
      windowMinutes: minutes,
      hostsOpened: stamped.length,
      approvalsResolved: approved.length,
    };
  }

  /**
   * Close the fleet window and everything standing behind it.
   *
   * Order is load-bearing: sweep, then audit, then compare-and-delete the key.
   * The key is the retry token — while it survives, the next worker tick knows
   * work is owed, so a crash at any point recovers within one tick. Deleting
   * first would discard that token and could leave the fleet open indefinitely.
   *
   * `deleteIf` elects a single closer. If it loses — an operator opened a fresh
   * window in the moment between our read and our sweep — the sweep just cleared
   * that new window's host stamps, so they are written back rather than left for
   * `enforce()` to repair one host at a time.
   */
  async closeFleetWindow(reason: 'manual' | 'expired', actor?: InsecureWindowActor): Promise<{
    closed: boolean;
    hosts: number;
    domains: number;
  }> {
    if (ownerRuntimeFor(this.db)) return this.owned('insecure.fleet.close', { reason, actor }, (ctx, publish) => {
      const raw = ctx.snapshot.setting(INSECURE_FLEET_WINDOW_KEY); const until = parseDate(raw);
      const now = Date.now(); const at = nowIso();
      // A queued expiry cannot revoke a newer grant.
      if (reason === 'expired' && (!until || until.getTime() > now)) return { closed: false, hosts: 0, domains: 0 };
      let hostCount = 0; let domainCount = 0;
      for (const host of ctx.draft.table('hosts').all()) {
        if (host.secure === 1) continue;
        const enabled = parseDate(host.insecureEnabledUntil)?.getTime() ?? 0; const grace = parseDate(host.insecureGraceUntil)?.getTime() ?? 0;
        if (reason === 'expired' && until && enabled > until.getTime() || enabled <= now && grace <= now) continue;
        stageUpdate(ctx, 'hosts', host.id, { insecureEnabledUntil: null, insecureGraceUntil: null, insecureSessionRenewalBlocked: reason === 'manual' ? 1 : 0, updatedAt: at });
        this.ownedLog(ctx, host.id, 'admin.host.insecure_disable', { fqdn: host.fqdn, source: `fleet_window_${reason}`, ...(actor ? { actor } : {}) });
        publish('host.updated', { id: host.id }); hostCount++;
      }
      for (const domain of ctx.draft.table('insecureDomainAllows').all()) {
        if (domain.revokedAt || domain.enabledUntil && (parseDate(domain.enabledUntil)?.getTime() ?? 0) <= now) continue;
        stageUpdate(ctx, 'insecureDomainAllows', domain.id, { enabledUntil: at, updatedAt: at }); domainCount++;
      }
      if (raw !== null) {
        ctx.draft.remove('versions', INSECURE_FLEET_WINDOW_KEY);
        ctx.write(async tx => tx.delete(versions).where(eq(versions.name, INSECURE_FLEET_WINDOW_KEY)));
        const details = { action: 'fleet_window_closed', reason, hosts_disabled: hostCount, domains_expired: domainCount, ...(actor ? { actor } : {}) };
        this.ownedLog(ctx, null, 'admin.insecure.fleet_window_close', { ...details, enabled_until: raw }); adminAudit(ctx, 'insecure.approval.changed', details);
        publish('insecure.approval.changed', { source: 'fleet_window_closed', reason });
      }
      return { closed: raw !== null, hosts: hostCount, domains: domainCount };
    });
    const state = await this.fleetWindowState();
    const counts = await closeAllInsecureAccess(this.db, async (host) => {
      await this.writeLog(host.id, 'admin.host.insecure_disable', {
        ...(actor ? { actor } : {}),
        fqdn: host.fqdn,
        source: `fleet_window_${reason}`,
      });
      wsPublisher.publish('host.updated', { id: host.id });
    }, reason === 'expired' ? state.until : null);

    if (state.raw === null) {
      // No window was stored; the sweep still ran, which is what "disable all"
      // means on its own. Nothing to retract.
      return { closed: false, hosts: counts.hosts, domains: counts.domains };
    }

    await this.writeLog(null, 'admin.insecure.fleet_window_close', {
      ...(actor ? { actor } : {}),
      reason,
      hosts_disabled: counts.hosts,
      domains_expired: counts.domains,
      enabled_until: state.raw,
    });

    const won = await this.settings.deleteIf(INSECURE_FLEET_WINDOW_KEY, state.raw);
    if (!won) {
      const fresh = await this.fleetWindowState();
      if (fresh.open && fresh.until) await stampAllInsecureHosts(this.db, fresh.until);
      return { closed: false, hosts: counts.hosts, domains: counts.domains };
    }

    await this.events.appendAndPublish(
      'insecure.approval.changed',
      {
        action: 'fleet_window_closed',
        ...(actor ? { actor } : {}),
        reason,
        hosts_disabled: counts.hosts,
        domains_expired: counts.domains,
      },
      {
        wsType: 'insecure.approval.changed',
        wsPayload: { source: 'fleet_window_closed', reason },
      },
    );
    return { closed: true, hosts: counts.hosts, domains: counts.domains };
  }

  /** Close the window if its deadline has passed. The worker's whole job. */
  async sweepIfLapsed(): Promise<boolean> {
    const state = await this.fleetWindowState();
    if (!state.lapsed) return false;
    const result = await this.closeFleetWindow('expired');
    return result.closed;
  }

  // ────────── enable / disable ──────────

  async enable(hostId: number, durationMinutes: number | null, actor?: { host_id: number; agent_address: string; session_id: string }, authorize?: (snapshot: OwnerStateSnapshot) => void): Promise<Host> {
    if (ownerRuntimeFor(this.db)) return this.owned('insecure.host.enable', { hostId, durationMinutes, actor }, (ctx, publish) => {
      const host = ctx.draft.table('hosts').get(hostId);
      if (!host) throw new NotFoundError('Host not found');
      if (host.secure === 1) throw new ValidationError('Host is secure; insecure window not applicable');
      const fallback = host.insecureWindowMinutes ?? DEFAULT_INSECURE_WINDOW_MINUTES;
      const minutes = clampInsecureMinutes(durationMinutes ?? fallback, fallback);
      const until = this.ownedGrant(ctx, host, minutes);
      const details = { host_id: hostId, fqdn: host.fqdn, enabled_until: until.toISOString(), window_minutes: minutes, ...(actor ? { source: 'secure_host', actor } : {}) };
      this.ownedLog(ctx, hostId, 'admin.host.insecure_enable', details); adminAudit(ctx, 'insecure.requested', details, nowIso(), hostId);
      publish('insecure.approval.changed', { host_id: hostId, fqdn: host.fqdn, source: 'admin_enable' });
      return ctx.draft.table('hosts').get(hostId)!;
    }, authorize);
    const host = await this.findHost(hostId);
    if (host.secure === 1) {
      throw new ValidationError('Host is secure; insecure window not applicable');
    }

    const now = Date.now();
    const currentEnabled = parseDate(host.insecureEnabledUntil);
    const baseMs = currentEnabled && currentEnabled.getTime() > now
      ? currentEnabled.getTime()
      : now;

    const fallback = host.insecureWindowMinutes ?? DEFAULT_INSECURE_WINDOW_MINUTES;
    const minutes = clampInsecureMinutes(durationMinutes ?? fallback, fallback);
    const enabledUntil = new Date(baseMs + minutes * 60_000);
    const graceMinutes = clampInsecureMinutes(this.env.INSECURE_GRACE_MINUTES, 60);
    const grace = computeGraceUntil(enabledUntil, minutes, graceMinutes);

    await this.db
      .update(hosts)
      .set({
        insecureEnabledUntil: enabledUntil,
        insecureSessionRenewalBlocked: 0,
        insecureGraceUntil: grace,
        insecureWindowMinutes: minutes,
        updatedAt: nowIso(),
      })
      .where(eq(hosts.id, hostId));

    await this.writeLog(hostId, 'admin.host.insecure_enable', {
      ...(actor ? { source: 'secure_host', actor } : {}),
      fqdn: host.fqdn,
      enabled_until: enabledUntil.toISOString(),
      window_minutes: minutes,
    });

    const fresh = await this.findHost(hostId);
    await this.events.appendAndPublish(
      'insecure.requested',
      {
        host_id: hostId,
        ...(actor ? { source: 'secure_host', actor } : {}),
        fqdn: host.fqdn,
        enabled_until: enabledUntil.toISOString(),
        window_minutes: minutes,
      },
      {
        hostId,
        wsType: 'insecure.approval.changed',
        wsPayload: { host_id: hostId, fqdn: host.fqdn, source: 'admin_enable' },
      },
    );
    return fresh;
  }

  async disable(hostId: number, actor?: InsecureWindowActor): Promise<Host> {
    if (ownerRuntimeFor(this.db)) return this.owned('insecure.host.disable', { hostId, actor }, (ctx, publish) => {
      const host = ctx.draft.table('hosts').get(hostId);
      if (!host) throw new NotFoundError('Host not found');
      const fleet = parseDate(ctx.snapshot.setting(INSECURE_FLEET_WINDOW_KEY));
      if (fleet && fleet.getTime() > Date.now()) throw new ConflictError('Fleet insecure window is open; close it first', 'insecure_fleet_window_open');
      stageUpdate(ctx, 'hosts', hostId, { insecureEnabledUntil: null, insecureSessionRenewalBlocked: 1, insecureGraceUntil: null, updatedAt: nowIso() });
      const details = { host_id: hostId, fqdn: host.fqdn, action: 'disabled', ...(actor ? { actor } : {}) };
      this.ownedLog(ctx, hostId, 'admin.host.insecure_disable', details); adminAudit(ctx, 'insecure.approval.changed', details, nowIso(), hostId);
      publish('insecure.approval.changed', { host_id: hostId });
      return ctx.draft.table('hosts').get(hostId)!;
    });
    const host = await this.findHost(hostId);
    // Refuse rather than lie. With the fleet window open, `enforce()` re-stamps
    // this host on its very next request, so clearing the columns here would
    // report success and change nothing for more than a few seconds.
    const fleet = await this.fleetWindowState();
    if (fleet.open) {
      throw new ConflictError(
        'Fleet insecure window is open; close it first',
        'insecure_fleet_window_open',
      );
    }
    await this.db
      .update(hosts)
      .set({
        insecureEnabledUntil: null,
        insecureSessionRenewalBlocked: 1,
        insecureGraceUntil: null,
        updatedAt: nowIso(),
      })
      .where(eq(hosts.id, hostId));
    await this.writeLog(hostId, 'admin.host.insecure_disable', { fqdn: host.fqdn, ...(actor ? { actor } : {}) });
    const fresh = await this.findHost(hostId);
    await this.events.appendAndPublish(
      'insecure.approval.changed',
      { host_id: hostId, fqdn: host.fqdn, action: 'disabled', ...(actor ? { actor } : {}) },
      { hostId, wsType: 'insecure.approval.changed', wsPayload: { host_id: hostId } },
    );
    return fresh;
  }

  // ────────── pending list ──────────

  async listPending(limit = 50): Promise<InsecureRequestRow[]> {
    await this.sweepStaleRequests();
    const cap = Math.min(Math.max(1, limit), 200);
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      owner.assertOwner(); const snapshot = owner.state.snapshot();
      return [...snapshot.table('insecureAuthRequests').by('status', 'pending')].sort((a,b) => a.id-b.id).slice(0,cap).map(row => ({ id: row.id, host_id: row.hostId, fqdn: snapshot.hosts.get(row.hostId)?.fqdn ?? '', request_ip: row.requestIp, requested_at: row.requestedAt, resolved_at: row.resolvedAt, updated_at: row.updatedAt, status: row.status, expires_at: expiresAt(row.requestedAt), live: admissionInterestAt(owner, row.id) !== undefined }));
    }
    const rows = await this.db
      .select({
        id: insecureAuthRequests.id,
        hostId: insecureAuthRequests.hostId,
        status: insecureAuthRequests.status,
        requestIp: insecureAuthRequests.requestIp,
        requestedAt: insecureAuthRequests.requestedAt,
        resolvedAt: insecureAuthRequests.resolvedAt,
        updatedAt: insecureAuthRequests.updatedAt,
        fqdn: hosts.fqdn,
      })
      .from(insecureAuthRequests)
      .leftJoin(hosts, eq(hosts.id, insecureAuthRequests.hostId))
      .where(eq(insecureAuthRequests.status, 'pending'))
      .orderBy(asc(insecureAuthRequests.id))
      .limit(cap);
    return rows.map((r) => ({
      id: r.id,
      host_id: r.hostId,
      fqdn: r.fqdn ?? '',
      request_ip: r.requestIp,
      requested_at: r.requestedAt,
      resolved_at: r.resolvedAt,
      updated_at: r.updatedAt,
      status: r.status,
      expires_at: expiresAt(r.requestedAt),
      live: r.updatedAt !== r.requestedAt,
    }));
  }

  // ────────── findRequest ──────────

  private async findRequest(id: number) {
    const owner = ownerRuntimeFor(this.db);
    if (owner) { owner.assertOwner(); return owner.state.snapshot().table('insecureAuthRequests').get(id) ?? null; }
    const rows = await this.db
      .select()
      .from(insecureAuthRequests)
      .where(eq(insecureAuthRequests.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Serialize decisions from desktop and phone; audit commits with the host grant. */
  private async resolveLocked<T>(requestId: number, action: (service: InsecureWindowAdminService) => Promise<T>, audit?: Record<string, unknown>): Promise<T> {
    const publications: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const result = await this.db.transaction(async tx => {
      const locked = await tx.select().from(insecureAuthRequests).where(eq(insecureAuthRequests.id, requestId)).for('update');
      if (!locked[0]) throw new NotFoundError('Request not found');
      await tx.select().from(hosts).where(eq(hosts.id, locked[0].hostId)).for('update');
      const db = tx as unknown as Database;
      const writer = this.events.withDb?.(db) ?? this.events;
      const events: AdminEventsWriter = {
        append: writer.append,
        appendAndPublish: async (type, payload, options = {}) => {
          const event = await writer.append(type, payload, options.hostId);
          publications.push({ type: options.wsType ?? type, payload: options.wsPayload ?? payload });
          return event;
        },
      };
      const resolved = await action(new InsecureWindowAdminService({ db, env: this.env, events }));
      if (audit) await writer.append('companion.approval.resolved', { ...audit, request_id: requestId });
      return resolved;
    });
    for (const event of publications) wsPublisher.publish(event.type, event.payload);
    return result;
  }

  async approve(requestId: number, durationMinutes: number | null, audit?: Record<string, unknown>) {
    if (ownerRuntimeFor(this.db)) return this.owned('insecure.request.approve', { requestId, durationMinutes, audit }, (ctx, publish) => {
      const req = ctx.draft.table('insecureAuthRequests').get(requestId);
      if (!req) throw new NotFoundError('Request not found');
      if (req.status !== 'pending' || stalePendingReason(pendingWithInterest(ownerRuntimeFor(this.db)!, req))) throw new ConflictError('Request already resolved');
      const host = ctx.draft.table('hosts').get(req.hostId);
      if (!host) throw new NotFoundError('Host not found');
      if (host.secure === 1) throw new ValidationError('Host is secure; insecure window not applicable');
      const minutes = clampInsecureMinutes(durationMinutes ?? APPROVAL_WINDOW_MINUTES, APPROVAL_WINDOW_MINUTES);
      const until = this.ownedGrant(ctx, host, minutes); const fresh = ctx.draft.table('hosts').get(host.id)!;
      stageUpdate(ctx, 'insecureAuthRequests', requestId, { status: 'approved', resolvedAt: nowIso(), updatedAt: nowIso() });
      const details = { host_id: host.id, fqdn: host.fqdn, request_id: requestId };
      this.ownedLog(ctx, host.id, 'admin.host.insecure_enable', { ...details, enabled_until: until.toISOString(), window_minutes: minutes, source: 'approval' });
      this.ownedLog(ctx, host.id, 'admin.insecure.approval', details); adminAudit(ctx, 'insecure.approved', details, nowIso(), host.id);
      if (audit) adminAudit(ctx, 'companion.approval.resolved', { ...audit, request_id: requestId });
      publish('insecure.approved', { host_id: host.id, request_id: requestId });
      return { requestId, host: fresh, enabledUntil: until.toISOString(), graceUntil: fresh.insecureGraceUntil?.toISOString() ?? null, windowMinutes: minutes };
    });
    return this.resolveLocked(requestId, service => service.approveLocked(requestId, durationMinutes), audit);
  }

  async deny(requestId: number, audit?: Record<string, unknown>) {
    if (ownerRuntimeFor(this.db)) return this.owned('insecure.request.deny', { requestId, audit }, (ctx, publish) => {
      const req = ctx.draft.table('insecureAuthRequests').get(requestId);
      if (!req) throw new NotFoundError('Request not found');
      if (req.status !== 'pending' || stalePendingReason(pendingWithInterest(ownerRuntimeFor(this.db)!, req))) throw new ConflictError('Request already resolved');
      const host = ctx.draft.table('hosts').get(req.hostId); if (!host) throw new NotFoundError('Host not found');
      stageUpdate(ctx, 'insecureAuthRequests', requestId, { status: 'denied', resolvedAt: nowIso(), updatedAt: nowIso() });
      const details = { host_id: host.id, fqdn: host.fqdn, request_id: requestId };
      this.ownedLog(ctx, host.id, 'admin.insecure.denied', details); adminAudit(ctx, 'insecure.denied', details, nowIso(), host.id);
      if (audit) adminAudit(ctx, 'companion.approval.resolved', { ...audit, request_id: requestId });
      publish('insecure.denied', { host_id: host.id, request_id: requestId });
      return { requestId, host };
    });
    return this.resolveLocked(requestId, service => service.denyLocked(requestId), audit);
  }

  // ────────── approve ──────────

  private async approveLocked(requestId: number, durationMinutes: number | null): Promise<{
    requestId: number;
    host: Host;
    enabledUntil: string;
    graceUntil: string | null;
    windowMinutes: number;
  }> {
    const req = await this.findRequest(requestId);
    if (!req) throw new NotFoundError('Request not found');
    if (await this.expirePendingRequest(req)) throw new ConflictError('Request already resolved');
    if (req.status !== 'pending') throw new ConflictError('Request already resolved');
    const host = await this.findHost(req.hostId);
    if (host.secure === 1) {
      throw new ValidationError('Host is secure; insecure window not applicable');
    }

    const minutes = clampInsecureMinutes(
      durationMinutes ?? APPROVAL_WINDOW_MINUTES,
      APPROVAL_WINDOW_MINUTES,
    );
    const enabledUntil = await this.stampHostWindow(host, minutes, 'approval', requestId);
    const graceMinutes = clampInsecureMinutes(this.env.INSECURE_GRACE_MINUTES, 60);
    const grace = computeGraceUntil(enabledUntil, minutes, graceMinutes);

    await this.db
      .update(insecureAuthRequests)
      .set({ status: 'approved', resolvedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(insecureAuthRequests.id, requestId));

    await this.writeLog(host.id, 'admin.insecure.approval', {
      fqdn: host.fqdn,
      request_id: requestId,
    });

    const fresh = await this.findHost(host.id);
    await this.events.appendAndPublish(
      'insecure.approved',
      { host_id: host.id, fqdn: host.fqdn, request_id: requestId },
      {
        hostId: host.id,
        wsType: 'insecure.approved',
        wsPayload: { host_id: host.id, request_id: requestId },
      },
    );

    return {
      requestId,
      host: fresh,
      enabledUntil: enabledUntil.toISOString(),
      graceUntil: grace ? grace.toISOString() : null,
      windowMinutes: minutes,
    };
  }

  // ────────── deny ──────────

  private async denyLocked(requestId: number): Promise<{ requestId: number; host: Host }> {
    const req = await this.findRequest(requestId);
    if (!req) throw new NotFoundError('Request not found');
    if (await this.expirePendingRequest(req)) throw new ConflictError('Request already resolved');
    if (req.status !== 'pending') throw new ConflictError('Request already resolved');
    const host = await this.findHost(req.hostId);

    await this.db
      .update(insecureAuthRequests)
      .set({ status: 'denied', resolvedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(insecureAuthRequests.id, requestId));
    await this.writeLog(host.id, 'admin.insecure.denied', {
      fqdn: host.fqdn,
      request_id: requestId,
    });
    await this.events.appendAndPublish(
      'insecure.denied',
      { host_id: host.id, fqdn: host.fqdn, request_id: requestId },
      {
        hostId: host.id,
        wsType: 'insecure.denied',
        wsPayload: { host_id: host.id, request_id: requestId },
      },
    );
    return { requestId, host };
  }

  // ────────── allow-domain (open window for the parent domain) ──────────

  /**
   * Allow a whole domain, and resolve every pending request it now covers.
   *
   * The sweep is the point. `enforce()`'s domain branch admits any host whose
   * FQDN matches an active allow, so the moment this row is written, every other
   * pending request under the same domain is already decided — leaving them in
   * the operator's list asks for clicks whose answer the gate has stopped
   * reading. The match uses the same suffix rule as `findActiveDomainAllow`
   * (see `fqdnMatchesDomain`), so the set the UI clears is exactly the set the
   * gate would wave through.
   *
   * `permanent` writes `enabled_until = NULL`, which `findActiveDomainAllow`
   * already treats as always-active. It is a separate flag rather than a
   * zero-minute duration because 0 is a legal window length meaning "closed",
   * and `window_minutes` still has a job here: it is how long a *host* window
   * stays open when the domain branch admits it.
   */
  async allowDomain(
    requestId: number,
    domainInput: string | null,
    durationMinutes: number | null,
    permanent = false,
  ): Promise<{
    requestId: number;
    host: Host;
    domain: InsecureDomainAllowRow;
    enabledUntil: string;
    graceUntil: string | null;
    windowMinutes: number;
    clearedRequestIds: number[];
  }> {
    if (ownerRuntimeFor(this.db)) return this.owned('insecure.domain.allow', { requestId, domainInput, durationMinutes, permanent }, (ctx, publish) => {
      const req = ctx.draft.table('insecureAuthRequests').get(requestId); if (!req) throw new NotFoundError('Request not found');
      if (req.status !== 'pending' || stalePendingReason(pendingWithInterest(ownerRuntimeFor(this.db)!, req))) throw new ConflictError('Request already resolved');
      const host = ctx.draft.table('hosts').get(req.hostId); if (!host) throw new NotFoundError('Host not found');
      if (host.secure === 1) throw new ValidationError('Host is secure; insecure window not applicable');
      const domain = normalizeDomainCandidate(domainInput) ?? resolveParentDomain(host.fqdn);
      if (!domain) throw new ValidationError('Domain must be a subdomain like cluster.example.com', { param: 'domain' });
      const fqdn = host.fqdn.toLowerCase().trim(); const suffix = '.' + domain;
      if (fqdn.length <= suffix.length || !fqdn.endsWith(suffix)) throw new ValidationError('Domain must be a parent of the host FQDN', { param: 'domain' });
      const minutes = clampInsecureMinutes(durationMinutes ?? APPROVAL_WINDOW_MINUTES, APPROVAL_WINDOW_MINUTES);
      const at = nowIso(); const enabled = permanent ? null : new Date(Date.now()+minutes*60_000).toISOString();
      const existing = ctx.draft.table('insecureDomainAllows').all().find(row => row.domain.toLowerCase() === domain.toLowerCase());
      const values = { domain, windowMinutes: minutes, enabledUntil: enabled, revokedAt: null, updatedAt: at, createdAt: existing?.createdAt ?? at };
      const allow: InsecureDomainAllowRow = { id: existing?.id ?? 0, domain, window_minutes: minutes, enabled_until: enabled, revoked_at: null, created_at: values.createdAt, updated_at: at };
      if (existing) stageUpdate(ctx, 'insecureDomainAllows', existing.id, values);
      else ctx.write(async tx => { const [inserted] = await tx.insert(insecureDomainAllows).values(values); allow.id = Number(inserted.insertId); ctx.draft.upsert('insecureDomainAllows', { ...values, id: allow.id }); });
      const until = this.ownedGrant(ctx, host, minutes); const fresh = ctx.draft.table('hosts').get(host.id)!;
      const clearedRequestIds: number[] = [];
      const candidates = [req, ...[...ctx.draft.table('insecureAuthRequests').by('status', 'pending')].filter(row => row.id !== requestId).sort((a,b) => a.id-b.id).slice(0, DOMAIN_SWEEP_LIMIT)];
      for (const candidate of candidates) {
        const sibling = ctx.draft.table('hosts').get(candidate.hostId);
        if (!sibling || sibling.secure === 1 || !fqdnMatchesDomain(sibling.fqdn, domain)) continue;
        if (candidate.id !== requestId) this.ownedGrant(ctx, sibling, minutes);
        stageUpdate(ctx, 'insecureAuthRequests', candidate.id, { status: 'approved', resolvedAt: at, updatedAt: at }); clearedRequestIds.push(candidate.id);
        this.ownedLog(ctx, sibling.id, 'admin.insecure.approval', { fqdn: sibling.fqdn, request_id: candidate.id, ...(candidate.id !== requestId ? { source: 'domain_sweep', domain } : {}) });
        this.ownedLog(ctx, sibling.id, 'admin.host.insecure_enable', { fqdn: sibling.fqdn, request_id: candidate.id, source: 'approval_domain', window_minutes: minutes, enabled_until: ctx.draft.table('hosts').get(sibling.id)!.insecureEnabledUntil!.toISOString() });
        if (candidate.id !== requestId) publish('host.updated', { id: sibling.id });
      }
      ctx.write(async tx => persistAuditLog(tx, { hostId: host.id, action: 'admin.insecure.domain_allow', createdAt: at, details: JSON.stringify({ fqdn: host.fqdn, domain, domain_id: allow.id, enabled_until: enabled, window_minutes: minutes, request_id: requestId }) }));
      adminAudit(ctx, 'insecure.domain.allowed', () => ({ host_id: host.id, fqdn: host.fqdn, domain, domain_id: allow.id, request_id: requestId, permanent, cleared_request_ids: clearedRequestIds }), at, host.id);
      // Publication reads the generated ID only after persistence finishes.
      const notification = { host_id: host.id, domain, get domain_id() { return allow.id; }, request_id: requestId, cleared_request_ids: clearedRequestIds };
      publish('insecure.domain.allowed', notification);
      return { requestId, host: fresh, domain: allow, enabledUntil: until.toISOString(), graceUntil: fresh.insecureGraceUntil?.toISOString() ?? null, windowMinutes: minutes, clearedRequestIds };
    });
    const req = await this.findRequest(requestId);
    if (!req) throw new NotFoundError('Request not found');
    if (await this.expirePendingRequest(req)) throw new ConflictError('Request already resolved');
    if (req.status !== 'pending') throw new ConflictError('Request already resolved');
    const host = await this.findHost(req.hostId);
    if (host.secure === 1) {
      throw new ValidationError('Host is secure; insecure window not applicable');
    }

    const explicit = normalizeDomainCandidate(domainInput);
    const domain = explicit ?? resolveParentDomain(host.fqdn);
    if (!domain) {
      throw new ValidationError('Domain must be a subdomain like cluster.example.com', {
        param: 'domain',
      });
    }
    const hostFqdn = (host.fqdn ?? '').toLowerCase().trim();
    const suffix = `.${domain}`;
    if (!hostFqdn || hostFqdn.length <= suffix.length || !hostFqdn.endsWith(suffix)) {
      throw new ValidationError('Domain must be a parent of the host FQDN', { param: 'domain' });
    }

    const minutes = clampInsecureMinutes(
      durationMinutes ?? APPROVAL_WINDOW_MINUTES,
      APPROVAL_WINDOW_MINUTES,
    );
    const now = Date.now();
    const domainEnabledUntil = permanent ? null : new Date(now + minutes * 60_000).toISOString();

    // Upsert the insecure_domain_allows row.
    const existing = await this.db
      .select()
      .from(insecureDomainAllows)
      .where(eq(insecureDomainAllows.domain, domain))
      .limit(1);
    const nowStr = nowIso();
    let domainId: number;
    if (existing[0]) {
      await this.db
        .update(insecureDomainAllows)
        .set({
          windowMinutes: minutes,
          enabledUntil: domainEnabledUntil,
          revokedAt: null,
          updatedAt: nowStr,
        })
        .where(eq(insecureDomainAllows.id, existing[0].id));
      domainId = existing[0].id;
    } else {
      const ins = await this.db.insert(insecureDomainAllows).values({
        domain,
        windowMinutes: minutes,
        enabledUntil: domainEnabledUntil,
        createdAt: nowStr,
        updatedAt: nowStr,
      });
      domainId =
        Array.isArray(ins) && ins[0] && typeof (ins[0] as { insertId?: number }).insertId === 'number'
          ? (ins[0] as { insertId: number }).insertId
          : 0;
    }
    const allow: InsecureDomainAllowRow = {
      id: domainId,
      domain,
      window_minutes: minutes,
      enabled_until: domainEnabledUntil,
      revoked_at: null,
      created_at: existing[0]?.createdAt ?? nowStr,
      updated_at: nowStr,
    };
    await this.writeLog(host.id, 'admin.insecure.domain_allow', {
      fqdn: host.fqdn,
      domain,
      domain_id: domainId,
      enabled_until: domainEnabledUntil,
      window_minutes: minutes,
      request_id: requestId,
    });

    // Also bump the host window itself
    const enabledUntil = await this.stampHostWindow(host, minutes, 'approval_domain', requestId);
    const graceMinutes = clampInsecureMinutes(this.env.INSECURE_GRACE_MINUTES, 60);
    const grace = computeGraceUntil(enabledUntil, minutes, graceMinutes);

    await this.db
      .update(insecureAuthRequests)
      .set({ status: 'approved', resolvedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(insecureAuthRequests.id, requestId));
    await this.writeLog(host.id, 'admin.insecure.approval', {
      fqdn: host.fqdn,
      request_id: requestId,
    });

    // Sweep the siblings this allow just decided.
    const clearedRequestIds = [requestId, ...(await this.resolveSiblingRequests(domain, minutes))];

    await this.events.appendAndPublish(
      'insecure.domain.allowed',
      {
        host_id: host.id,
        fqdn: host.fqdn,
        domain,
        domain_id: domainId,
        request_id: requestId,
        permanent,
        cleared_request_ids: clearedRequestIds,
      },
      {
        hostId: host.id,
        wsType: 'insecure.domain.allowed',
        wsPayload: {
          host_id: host.id,
          domain,
          domain_id: domainId,
          request_id: requestId,
          cleared_request_ids: clearedRequestIds,
        },
      },
    );

    const fresh = await this.findHost(host.id);
    return {
      requestId,
      host: fresh,
      domain: allow,
      enabledUntil: enabledUntil.toISOString(),
      graceUntil: grace ? grace.toISOString() : null,
      windowMinutes: minutes,
      clearedRequestIds,
    };
  }

  /**
   * Approve every *other* pending request whose host now falls under `domain`.
   *
   * Not routed through `approve()` on purpose, for the same reason
   * `approveAllPendingInsecureRequests` isn't: `approve()` auto-denies anything
   * past the five-minute TTL and then throws. A sibling that has been waiting
   * six minutes when the operator allows its domain would be denied rather than
   * let in — the opposite of what allowing the domain means.
   */
  private async resolveSiblingRequests(domain: string, minutes: number): Promise<number[]> {
    const rows = await this.db
      .select()
      .from(insecureAuthRequests)
      .where(eq(insecureAuthRequests.status, 'pending'))
      .orderBy(asc(insecureAuthRequests.id))
      .limit(DOMAIN_SWEEP_LIMIT);

    const cleared: number[] = [];
    for (const row of rows) {
      const host = await this.findHost(row.hostId).catch(() => null);
      if (!host) continue;
      if (host.secure === 1) continue;
      if (!fqdnMatchesDomain(host.fqdn, domain)) continue;

      await this.stampHostWindow(host, minutes, 'approval_domain', row.id);
      const resolvedAt = nowIso();
      await this.db
        .update(insecureAuthRequests)
        .set({ status: 'approved', resolvedAt, updatedAt: resolvedAt })
        .where(eq(insecureAuthRequests.id, row.id));
      await this.writeLog(host.id, 'admin.insecure.approval', {
        fqdn: host.fqdn,
        request_id: row.id,
        source: 'domain_sweep',
        domain,
      });
      wsPublisher.publish('host.updated', { id: host.id });
      cleared.push(row.id);
    }
    return cleared;
  }

  // ────────── revoke domain ──────────

  async revokeDomain(allowId: number): Promise<InsecureDomainAllowRow> {
    if (ownerRuntimeFor(this.db)) return this.owned('insecure.domain.revoke', { allowId }, (ctx, publish) => {
      const allow = ctx.draft.table('insecureDomainAllows').get(allowId); if (!allow) throw new NotFoundError('Domain allow not found');
      const at = nowIso(); stageUpdate(ctx, 'insecureDomainAllows', allowId, { revokedAt: at, updatedAt: at });
      const details = { domain: allow.domain, domain_id: allowId };
      this.ownedLog(ctx, null, 'admin.insecure.domain_revoke', details); adminAudit(ctx, 'insecure.domain.revoked', details);
      publish('insecure.domain.revoked', { domain: allow.domain, id: allowId });
      return { id: allowId, domain: allow.domain, window_minutes: allow.windowMinutes, enabled_until: allow.enabledUntil, revoked_at: at, created_at: allow.createdAt, updated_at: at };
    });
    const rows = await this.db
      .select()
      .from(insecureDomainAllows)
      .where(eq(insecureDomainAllows.id, allowId))
      .limit(1);
    const allow = rows[0];
    if (!allow) throw new NotFoundError('Domain allow not found');
    const nowStr = nowIso();
    await this.db
      .update(insecureDomainAllows)
      .set({ revokedAt: nowStr, updatedAt: nowStr })
      .where(eq(insecureDomainAllows.id, allowId));
    await this.writeLog(null, 'admin.insecure.domain_revoke', {
      domain: allow.domain,
      domain_id: allowId,
    });
    await this.events.appendAndPublish(
      'insecure.domain.revoked',
      { domain: allow.domain, domain_id: allowId },
      { wsType: 'insecure.domain.revoked', wsPayload: { domain: allow.domain, id: allowId } },
    );
    return {
      id: allow.id,
      domain: allow.domain,
      window_minutes: allow.windowMinutes,
      enabled_until: allow.enabledUntil,
      revoked_at: nowStr,
      created_at: allow.createdAt,
      updated_at: nowStr,
    };
  }
}

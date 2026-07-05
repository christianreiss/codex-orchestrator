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
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import {
  hosts,
  insecureAuthRequests,
  insecureDomainAllows,
  logs,
} from '../db/schema.js';
import type { Host } from '../db/schema.js';
import { nowIso } from '../util/timestamp.js';
import { NotFoundError, ValidationError, ConflictError } from '../http/errors.js';
import type { AdminEventsWriter } from './admin-events-writer.js';
import {
  clampInsecureMinutes,
  computeGraceUntil,
  DEFAULT_INSECURE_WINDOW_MINUTES,
} from './host-management.js';

const PENDING_APPROVAL_TTL_MS = 5 * 60_000;

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

function parseDate(s: string | Date | null | undefined): Date | null {
  if (!s) return null;
  if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
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

  private async writeLog(
    hostId: number | null,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insert(logs).values({
      hostId: hostId ?? null,
      action,
      details: Object.keys(details).length ? JSON.stringify(details) : null,
      createdAt: nowIso(),
    });
  }

  private async findHost(id: number): Promise<Host> {
    const rows = await this.db.select().from(hosts).where(eq(hosts.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundError('Host not found');
    return rows[0];
  }

  private isExpiredPendingRequest(req: { status: string; requestedAt: string }): boolean {
    if (req.status !== 'pending') return false;
    const requested = parseDate(req.requestedAt);
    if (!requested) return false;
    return Date.now() - requested.getTime() >= PENDING_APPROVAL_TTL_MS;
  }

  private async expirePendingRequest(req: {
    id: number;
    hostId: number;
    status: string;
    requestedAt: string;
  }): Promise<boolean> {
    if (!this.isExpiredPendingRequest(req)) return false;
    const resolvedAt = nowIso();
    await this.db
      .update(insecureAuthRequests)
      .set({ status: 'denied', resolvedAt, updatedAt: resolvedAt })
      .where(eq(insecureAuthRequests.id, req.id));

    const host = await this.findHost(req.hostId).catch(() => null);
    await this.writeLog(host?.id ?? req.hostId, 'admin.insecure.auto_denied', {
      fqdn: host?.fqdn ?? null,
      request_id: req.id,
      reason: 'timeout',
      ttl_seconds: PENDING_APPROVAL_TTL_MS / 1000,
    });
    await this.events.appendAndPublish(
      'insecure.denied',
      { host_id: req.hostId, fqdn: host?.fqdn ?? null, request_id: req.id, reason: 'timeout' },
      {
        hostId: req.hostId,
        wsType: 'insecure.denied',
        wsPayload: { host_id: req.hostId, request_id: req.id, reason: 'timeout' },
      },
    );
    return true;
  }

  private async expirePendingRequests(): Promise<void> {
    const rows = await this.db
      .select()
      .from(insecureAuthRequests)
      .where(eq(insecureAuthRequests.status, 'pending'));
    for (const req of rows) {
      await this.expirePendingRequest(req);
    }
  }

  // ────────── enable / disable ──────────

  async enable(hostId: number, durationMinutes: number | null): Promise<Host> {
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
        insecureGraceUntil: grace,
        insecureWindowMinutes: minutes,
        updatedAt: nowIso(),
      })
      .where(eq(hosts.id, hostId));

    await this.writeLog(hostId, 'admin.host.insecure_enable', {
      fqdn: host.fqdn,
      enabled_until: enabledUntil.toISOString(),
      window_minutes: minutes,
    });

    const fresh = await this.findHost(hostId);
    await this.events.appendAndPublish(
      'insecure.requested',
      {
        host_id: hostId,
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

  async disable(hostId: number): Promise<Host> {
    const host = await this.findHost(hostId);
    await this.db
      .update(hosts)
      .set({
        insecureEnabledUntil: null,
        insecureGraceUntil: null,
        updatedAt: nowIso(),
      })
      .where(eq(hosts.id, hostId));
    await this.writeLog(hostId, 'admin.host.insecure_disable', { fqdn: host.fqdn });
    const fresh = await this.findHost(hostId);
    await this.events.appendAndPublish(
      'insecure.approval.changed',
      { host_id: hostId, fqdn: host.fqdn, action: 'disabled' },
      { hostId, wsType: 'insecure.approval.changed', wsPayload: { host_id: hostId } },
    );
    return fresh;
  }

  // ────────── pending list ──────────

  async listPending(limit = 50): Promise<InsecureRequestRow[]> {
    await this.expirePendingRequests();
    const cap = Math.min(Math.max(1, limit), 200);
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
    }));
  }

  // ────────── findRequest ──────────

  private async findRequest(id: number) {
    const rows = await this.db
      .select()
      .from(insecureAuthRequests)
      .where(eq(insecureAuthRequests.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ────────── approve ──────────

  async approve(requestId: number, durationMinutes: number | null): Promise<{
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

    const now = Date.now();
    const currentEnabled = parseDate(host.insecureEnabledUntil);
    const baseMs = currentEnabled && currentEnabled.getTime() > now ? currentEnabled.getTime() : now;
    const fallback = host.insecureWindowMinutes ?? DEFAULT_INSECURE_WINDOW_MINUTES;
    const minutes = clampInsecureMinutes(durationMinutes ?? fallback, fallback);
    const enabledUntil = new Date(baseMs + minutes * 60_000);
    const graceMinutes = clampInsecureMinutes(this.env.INSECURE_GRACE_MINUTES, 60);
    const grace = computeGraceUntil(enabledUntil, minutes, graceMinutes);

    await this.db
      .update(hosts)
      .set({
        insecureEnabledUntil: enabledUntil,
        insecureGraceUntil: grace,
        insecureWindowMinutes: minutes,
        updatedAt: nowIso(),
      })
      .where(eq(hosts.id, host.id));

    await this.db
      .update(insecureAuthRequests)
      .set({ status: 'approved', resolvedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(insecureAuthRequests.id, requestId));

    await this.writeLog(host.id, 'admin.host.insecure_enable', {
      fqdn: host.fqdn,
      enabled_until: enabledUntil.toISOString(),
      window_minutes: minutes,
      source: 'approval',
      request_id: requestId,
    });
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

  async deny(requestId: number): Promise<{ requestId: number; host: Host }> {
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

  async allowDomain(
    requestId: number,
    domainInput: string | null,
    durationMinutes: number | null,
  ): Promise<{
    requestId: number;
    host: Host;
    domain: InsecureDomainAllowRow;
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

    const fallback = host.insecureWindowMinutes ?? DEFAULT_INSECURE_WINDOW_MINUTES;
    const minutes = clampInsecureMinutes(durationMinutes ?? fallback, fallback);
    const now = Date.now();
    const domainEnabledUntil = new Date(now + minutes * 60_000).toISOString();

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
    const currentEnabled = parseDate(host.insecureEnabledUntil);
    const baseMs =
      currentEnabled && currentEnabled.getTime() > now ? currentEnabled.getTime() : now;
    const enabledUntil = new Date(baseMs + minutes * 60_000);
    const graceMinutes = clampInsecureMinutes(this.env.INSECURE_GRACE_MINUTES, 60);
    const grace = computeGraceUntil(enabledUntil, minutes, graceMinutes);

    await this.db
      .update(hosts)
      .set({
        insecureEnabledUntil: enabledUntil,
        insecureGraceUntil: grace,
        insecureWindowMinutes: minutes,
        updatedAt: nowIso(),
      })
      .where(eq(hosts.id, host.id));
    await this.writeLog(host.id, 'admin.host.insecure_enable', {
      fqdn: host.fqdn,
      enabled_until: enabledUntil.toISOString(),
      window_minutes: minutes,
      source: 'approval_domain',
      request_id: requestId,
    });

    await this.db
      .update(insecureAuthRequests)
      .set({ status: 'approved', resolvedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(insecureAuthRequests.id, requestId));
    await this.writeLog(host.id, 'admin.insecure.approval', {
      fqdn: host.fqdn,
      request_id: requestId,
    });

    await this.events.appendAndPublish(
      'insecure.domain.allowed',
      {
        host_id: host.id,
        fqdn: host.fqdn,
        domain,
        domain_id: domainId,
        request_id: requestId,
      },
      {
        hostId: host.id,
        wsType: 'insecure.domain.allowed',
        wsPayload: { host_id: host.id, domain, domain_id: domainId, request_id: requestId },
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
    };
  }

  // ────────── revoke domain ──────────

  async revokeDomain(allowId: number): Promise<InsecureDomainAllowRow> {
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

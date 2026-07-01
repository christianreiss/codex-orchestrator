import type { FastifyRequest } from 'fastify';
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { hosts as hostsTable, type Host } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';
import { extractApiKey, hashApiKey } from '../util/api-key-helpers.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import type { AuthFailureTracker } from './auth-failure-tracker.js';
import type { InsecureWindowService } from './insecure-window.js';
import { SettingsService } from './settings.js';
import { assertReverseDnsMatch } from './reverse-dns.js';
import type { Env } from '../env.js';

/**
 * Host authentication helpers. Foundation already provides
 * `app.resolveHostFromKey` / `app.requireHost`; this service adds the
 * rate-limit + audit hooks the legacy PHP AuthService performed and exposes a
 * unified resolve that's reusable from cron/seed contexts.
 */
export interface HostAuthService {
  /**
   * Resolve a host by API key from a Fastify request. Records auth-fail
   * bucket hits on failure. Throws on missing/invalid/disabled host.
   */
  authenticate(req: FastifyRequest): Promise<Host>;
  /**
   * Remove inactive hosts whose `updatedAt` is older than `inactivity_window_days`
   * (default 30, max 60, 0 disables). Returns the count of removed rows.
   */
  pruneInactiveHosts(now?: Date): Promise<number>;
}

export interface HostAuthDeps {
  db: Database;
  failures: AuthFailureTracker;
  env: Env;
  insecure?: InsecureWindowService;
  settings?: SettingsService;
}

interface ParsedBypassCidr {
  range: [ipaddr.IPv4 | ipaddr.IPv6, number];
}

export function createHostAuthService(deps: HostAuthDeps): HostAuthService {
  const settings = deps.settings ?? new SettingsService(deps.db);
  const bypassCidrs = parseBypassCidrs(deps.env.AUTH_RUNNER_BYPASS_SUBNETS);

  return {
    async authenticate(req) {
      const key = extractApiKey(req.headers as Record<string, string | string[] | undefined>);
      const ip = req.clientIp || null;
      if (!key) {
        await deps.failures.recordFailure(ip, 'missing_api_key');
        throw new UnauthorizedError('API key missing', 'missing_api_key');
      }

      const hash = hashApiKey(key);
      const found = await deps.db
        .select()
        .from(hostsTable)
        .where(eq(hostsTable.apiKeyHash, hash))
        .limit(1);

      let host: Host | undefined = found[0];
      if (!host) {
        const legacy = await deps.db
          .select()
          .from(hostsTable)
          .where(eq(hostsTable.apiKey, key))
          .limit(1);
        host = legacy[0];
      }

      if (!host) {
        await deps.failures.recordFailure(ip, 'invalid_api_key');
        throw new UnauthorizedError('Invalid API key', 'invalid_api_key');
      }
      if (host.status && host.status !== 'active') {
        throw new ForbiddenError(`Host ${host.status}`, `host_${host.status}`);
      }

      const force = req.method === 'DELETE' && (req.query as { force?: string })?.force === '1';
      if (!force) {
        host = await enforceIpBinding(deps, host, ip, bypassCidrs);
        await enforceReverseDns(host, ip, settings);
      } else {
        logForceDeleteIpMismatch(req, host, ip);
      }
      return host;
    },

    async pruneInactiveHosts(now = new Date()) {
      const days = await settings.getInt('inactivity_window_days', 30);
      const clamped = days < 0 ? 0 : days > 60 ? 60 : days;
      if (clamped === 0) return 0;
      const cutoff = new Date(now.getTime() - clamped * 86400 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      const stale = await deps.db
        .select()
        .from(hostsTable)
        .where(and(isNotNull(hostsTable.updatedAt), lt(hostsTable.updatedAt, cutoff)));
      let removed = 0;
      for (const row of stale) {
        await deps.db.delete(hostsTable).where(eq(hostsTable.id, row.id));
        wsPublisher.publish('host.pruned', { id: row.id, fqdn: row.fqdn, reason: 'inactive' });
        removed += 1;
      }
      return removed;
    },
  };
}

async function enforceIpBinding(
  deps: HostAuthDeps,
  host: Host,
  ip: string | null,
  bypassCidrs: ParsedBypassCidr[],
): Promise<Host> {
  if (!ip) return host;
  const family = ipFamily(ip);
  if (!family) return host;

  if (deps.env.AUTH_RUNNER_IP_BYPASS && ipMatchesCidrs(ip, bypassCidrs)) return host;

  const bound4 = host.ip4 ?? null;
  const bound6 = host.ip6 ?? null;
  const boundSame = family === 'ipv4' ? bound4 : bound6;
  const boundOther = family === 'ipv4' ? bound6 : bound4;

  if (!bound4 && !bound6) {
    return bindIp(deps.db, host, ip, family);
  }
  if (boundSame && boundSame === ip) return host;
  if (boundSame && boundSame !== ip) {
    if (host.allowRoamingIps === 1) return bindIp(deps.db, host, ip, family);
    if (await canExtendInsecureWindow(deps, host)) return bindIp(deps.db, host, ip, family);
    throw new UnauthorizedError('API key not allowed from this IP', 'ip_mismatch');
  }
  // Same family not yet bound, other family is.
  if (boundOther) {
    if (host.allowRoamingIps === 1) return bindIp(deps.db, host, ip, family);
    if (await canExtendInsecureWindow(deps, host)) return bindIp(deps.db, host, ip, family);
    throw new UnauthorizedError('API key not allowed from this IP', 'ip_mismatch');
  }
  return host;
}

/**
 * Force-delete (`DELETE /auth?force=1`) intentionally skips IP-binding and
 * reverse-DNS enforcement so a host can self-uninstall after its network
 * position changed. That bypass still needs a non-bypassable trail: flag
 * force deletes whose request IP doesn't match either bound address so a
 * leaked key used off-network to deregister a host doesn't go unnoticed.
 */
function logForceDeleteIpMismatch(req: FastifyRequest, host: Host, ip: string | null): void {
  const bound4 = host.ip4 ?? null;
  const bound6 = host.ip6 ?? null;
  if (!bound4 && !bound6) return;
  if (!ip || ip === bound4 || ip === bound6) return;
  req.log.warn(
    { hostId: host.id, fqdn: host.fqdn, ip, boundIp4: bound4, boundIp6: bound6 },
    'force delete used from an IP that does not match the bound IP',
  );
  wsPublisher.publish('host.force_delete_ip_mismatch', { id: host.id, fqdn: host.fqdn, ip });
}

async function bindIp(db: Database, host: Host, ip: string, family: 'ipv4' | 'ipv6'): Promise<Host> {
  const patch = family === 'ipv4' ? { ip4: ip, updatedAt: nowIso() } : { ip6: ip, updatedAt: nowIso() };
  await db.update(hostsTable).set(patch).where(eq(hostsTable.id, host.id));
  return family === 'ipv4'
    ? { ...host, ip4: ip, updatedAt: patch.updatedAt }
    : { ...host, ip6: ip, updatedAt: patch.updatedAt };
}

async function canExtendInsecureWindow(deps: HostAuthDeps, host: Host): Promise<boolean> {
  if (host.secure === 1 || !deps.insecure) return false;
  try {
    await deps.insecure.enforce(host, 'auth');
    return true;
  } catch {
    return false;
  }
}

async function enforceReverseDns(
  host: Host,
  ip: string | null,
  settings: SettingsService,
): Promise<void> {
  if (!ip) return;
  const fleetEnabled = await settings.getFlag('reverse_dns_enabled', false);
  const mode = host.reverseDnsMode;
  const required = mode === 1 || (mode === null && fleetEnabled);
  if (!required) return;
  if (host.secure !== 1 && insecureWindowActive(host)) return;
  try {
    await assertReverseDnsMatch(host.fqdn, ip);
  } catch {
    throw new UnauthorizedError('Reverse DNS check failed', 'reverse_dns_failed');
  }
}

function insecureWindowActive(host: Host): boolean {
  const until = host.insecureEnabledUntil;
  if (!until) return false;
  const ms = until instanceof Date ? until.getTime() : new Date(until).getTime();
  return Number.isFinite(ms) && ms >= Date.now();
}

function ipFamily(ip: string): 'ipv4' | 'ipv6' | null {
  if (net.isIPv4(ip)) return 'ipv4';
  if (net.isIPv6(ip)) return 'ipv6';
  return null;
}

function parseBypassCidrs(raw: string | undefined): ParsedBypassCidr[] {
  if (!raw || !raw.trim()) return [];
  const out: ParsedBypassCidr[] = [];
  for (const part of raw.split(',')) {
    const cidr = part.trim();
    if (!cidr) continue;
    try {
      const parsed = ipaddr.parseCIDR(cidr) as [ipaddr.IPv4 | ipaddr.IPv6, number];
      out.push({ range: parsed });
    } catch {
      // ignore bad entries
    }
  }
  return out;
}

function ipMatchesCidrs(ip: string, cidrs: ParsedBypassCidr[]): boolean {
  if (cidrs.length === 0) return false;
  try {
    const addr = ipaddr.parse(ip);
    for (const c of cidrs) {
      if (addr.kind() !== c.range[0].kind()) continue;
      if ((addr as ipaddr.IPv4).match(c.range as [ipaddr.IPv4, number])) return true;
    }
  } catch {
    return false;
  }
  return false;
}

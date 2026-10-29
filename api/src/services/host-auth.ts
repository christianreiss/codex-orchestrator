import { bindOwnerHostPrincipal, ownerRuntimeFor, resolveOwnerHost, requestHost } from '../control-plane/state/admission.js';
import { mutateOwnerState } from '../control-plane/state/runtime.js';
import { readTransportAdmission } from './host-auth-admission.js';
import { wsPublisher } from '../ws/publisher.js';
import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { hosts as hostsTable, type Host } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';
import { extractApiKey, hashApiKey } from '../util/api-key-helpers.js';
import { nowIso } from '../util/timestamp.js';
import { insecureWindowActive, type InsecureWindowService } from './insecure-window.js';
import { SettingsService } from './settings.js';
import { assertReverseDnsMatch } from './reverse-dns.js';
import type { Env } from '../env.js';
import { assertHostNotExpired, pruneHosts, recordHostContact } from './host-lifecycle.js';
import { observeRequestApiLevel } from './communicator-api-version.js';

/**
 * Host authentication helpers. Foundation already provides
 * `app.resolveHostFromKey` / `app.requireHost`; this service adds the
 * audit hooks the legacy PHP AuthService performed and exposes a
 * unified resolve that's reusable from cron/seed contexts.
 */
export interface HostAuthService {
  /**
   * Resolve a host by API key from a Fastify request. Throws on a
   * missing, invalid, or disabled host.
   */
  authenticate(req: FastifyRequest, options?: { checkApiDisabled: true }): Promise<Host>;
  /**
   * Remove inactive, expired temporary and abandoned unprovisioned hosts.
   * A zero inactivity_window_days disables only the inactivity criterion.
   */
  pruneInactiveHosts(now?: Date): Promise<number>;
}

export interface HostAuthDeps {
  db: Database;
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
    async authenticate(req, options) {
      const key = extractApiKey(req.headers as Record<string, string | string[] | undefined>);
      const ip = req.clientIp || null;
      const assertApiEnabled = async () => {
        if (options?.checkApiDisabled && await settings.getRaw('api_disabled') === '1')
          throw new ForbiddenError('API disabled', 'api_disabled');
      };
      if (!key) {
        await assertApiEnabled();
        throw new UnauthorizedError('API key missing', 'missing_api_key');
      }

      const hash = hashApiKey(key);
      let host: Host | undefined;
      let reverseDnsDefault: boolean | undefined;
      if (options?.checkApiDisabled) {
        const admission = await readTransportAdmission(deps.db, hash, key);
        if (admission?.apiDisabled) throw new ForbiddenError('API disabled', 'api_disabled');
        host = admission?.host;
        reverseDnsDefault = admission?.reverseDnsDefault;
        if (!host) await assertApiEnabled();
      } else if (ownerRuntimeFor(deps.db)) {
        host = resolveOwnerHost(deps.db, hash, key) ?? undefined;
      } else {
        const found = await deps.db.select().from(hostsTable).where(eq(hostsTable.apiKeyHash, hash)).limit(1);
        host = found[0];
        if (!host) {
          const legacy = await deps.db.select().from(hostsTable).where(eq(hostsTable.apiKey, key)).limit(1);
          host = legacy[0];
        }
      }

      if (!host) {
        throw new UnauthorizedError('Invalid API key', 'invalid_api_key');
      }
      if (host.status && host.status !== 'active') {
        throw new ForbiddenError(`Host ${host.status}`, `host_${host.status}`);
      }

      assertHostNotExpired(host);
      const force = req.method === 'DELETE' && (req.query as { force?: string })?.force === '1';
      if (!force) {
        host = await enforceIpBinding(deps, host, ip, bypassCidrs);
        await enforceReverseDns(host, ip, settings, reverseDnsDefault);
      } else {
        logForceDeleteIpMismatch(req, host, ip);
      }
      if (req.method !== 'DELETE') host = await recordHostContact(deps.db, host, new Date(), true);
      if (ownerRuntimeFor(deps.db)) bindOwnerHostPrincipal(deps.db, host);
      req.authHost = host;
      observeRequestApiLevel(host.id, req.headers);
      return host;
    },

    async pruneInactiveHosts(now = new Date()) {
      return pruneHosts(deps.db, settings, now);
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
    if (canRebindInsecureHost(host)) return bindIp(deps.db, host, ip, family);
    throw ipMismatch(family);
  }
  // Same family not yet bound, other family is.
  if (boundOther) {
    if (host.allowRoamingIps === 1) return bindIp(deps.db, host, ip, family);
    if (canRebindInsecureHost(host)) return bindIp(deps.db, host, ip, family);
    throw ipMismatch(family);
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

/**
 * `ip_family` names the refused request's own address family -- something the
 * caller already knows -- so a dual-stack client can tell which path was
 * refused. It never reveals the bound addresses or which family is bound.
 */
function ipMismatch(family: 'ipv4' | 'ipv6'): UnauthorizedError {
  return new UnauthorizedError('API key not allowed from this IP', 'ip_mismatch', { ip_family: family });
}

async function bindIp(db: Database, host: Host, ip: string, family: 'ipv4' | 'ipv6'): Promise<Host> {
  const owner = ownerRuntimeFor(db);
  if (owner) {
    await mutateOwnerState(owner, { kind: 'host.ip.bind', principal: `host:${host.id}`, payload: { hostId: host.id, ip, family }, prepare(ctx) {
      const current = ctx.draft.table('hosts').get(host.id);
      if (!current || current.credentialLookupHash !== hashApiKey(host.apiKey) || current.status !== 'active') throw new UnauthorizedError('Host authority changed', 'invalid_api_key');
      const request = requestHost(current, host.apiKey); assertHostNotExpired(request);
      const same = family === 'ipv4' ? current.ip4 : current.ip6;
      if ((current.ip4 || current.ip6) && same !== ip && current.allowRoamingIps !== 1 && !canRebindInsecureHost(request)) throw ipMismatch(family);
      const patch = family === 'ipv4' ? { ip4: ip, updatedAt: nowIso() } : { ip6: ip, updatedAt: nowIso() };
      ctx.draft.upsert('hosts', { ...current, ...patch });
      ctx.write(async tx => tx.update(hostsTable).set(patch).where(eq(hostsTable.id, host.id)));
      return null;
    } });
    const current = resolveOwnerHost(db, hashApiKey(host.apiKey), host.apiKey);
    if (!current) throw new UnauthorizedError('Host authority changed', 'invalid_api_key');
    return current;
  }
  const patch = family === 'ipv4' ? { ip4: ip, updatedAt: nowIso() } : { ip6: ip, updatedAt: nowIso() };
  await db.update(hostsTable).set(patch).where(eq(hostsTable.id, host.id));
  return family === 'ipv4'
    ? { ...host, ip4: ip, updatedAt: patch.updatedAt }
    : { ...host, ip6: ip, updatedAt: patch.updatedAt };
}

function canRebindInsecureHost(host: Host): boolean {
  // IP authentication may use an existing grant, never create an approval or
  // slide a window. The authenticated route applies its own command policy.
  return host.secure !== 1 && insecureWindowActive(host);
}

async function enforceReverseDns(
  host: Host,
  ip: string | null,
  settings: SettingsService,
  snapshotDefault?: boolean,
): Promise<void> {
  if (!ip) return;
  const mode = host.reverseDnsMode;
  // Explicit host policy does not depend on the fleet default. Avoid a
  // settings query for every transport frame when the result cannot matter.
  const required = mode === 1 || (mode === null && (snapshotDefault ?? await settings.getFlag('reverse_dns_enabled', false)));
  if (!required) return;
  if (host.secure !== 1 && insecureWindowActive(host)) return;
  try {
    await assertReverseDnsMatch(host.fqdn, ip);
  } catch {
    throw new UnauthorizedError('Reverse DNS check failed', 'reverse_dns_failed');
  }
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

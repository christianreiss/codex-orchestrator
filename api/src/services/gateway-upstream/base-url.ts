/**
 * SSRF guard for the upstream forward. Two layers, both required:
 *
 * 1. `parseBaseUrl` validates an admin-supplied `base_url` when it is stored:
 *    https only (plain http only for a host in `GATEWAY_UPSTREAM_PRIVATE_HOSTS`),
 *    no userinfo, query or fragment, at most 512 characters, not this
 *    orchestrator's own `PUBLIC_BASE_URL` host, and no private or reserved IP
 *    literal. The WHATWG parser canonicalises decimal, octal and hex IPv4
 *    spellings first, so `http://2130706433/` is seen as `127.0.0.1`.
 * 2. `createGuardedConnector` checks every connection when it is made: a name
 *    is resolved with `all: true` and refused if ANY resolved address is
 *    blocked, and the socket connects to an address that passed the check, so
 *    a DNS rebind between validation and connect cannot reach an internal
 *    address. IP literals skip DNS (Node never calls `lookup` for them), so the
 *    connector checks them itself.
 *
 * Error messages never echo the submitted URL: an admin-chosen URL can carry a
 * credential in its userinfo.
 */
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { buildConnector } from 'undici';

export const MAX_BASE_URL_LENGTH = 512;

/** What may be reached and what must not. Hostnames are lower-case, without brackets or a trailing dot. */
export interface UpstreamNetworkPolicy {
  /** Hosts exempt from the address check (and allowed over plain http). */
  readonly privateHosts: ReadonlySet<string>;
  /** This orchestrator's own public hosts; never an upstream. */
  readonly ownHosts: ReadonlySet<string>;
}

export const DEFAULT_NETWORK_POLICY: UpstreamNetworkPolicy = { privateHosts: new Set(), ownHosts: new Set() };

/** Refused before a socket exists: a private, reserved or otherwise blocked address. */
export class UpstreamAddressBlockedError extends Error {
  readonly code = 'EGATEWAYBLOCKED';
  constructor(message = 'Upstream address is not allowed') {
    super(message);
    this.name = 'UpstreamAddressBlockedError';
  }
}

export class InvalidBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBaseUrlError';
  }
}

const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT (RFC 6598)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

const V6_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['::', 96], // unspecified, loopback, deprecated IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments: Teredo, ORCHID, benchmarking
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['5f00::', 16], // SRv6 SIDs
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

// Two lists on purpose: Node's BlockList matches an IPv4 address against IPv6
// rules through its IPv4-mapped form, so one list holding `::ffff:0:0/96`
// would block every IPv4 address.
const BLOCKED_V4 = new BlockList();
for (const [network, prefix] of V4_BLOCKED) BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of V6_BLOCKED) BLOCKED_V6.addSubnet(network, prefix, 'ipv6');

/** Eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function ipv6Groups(address: string): number[] | null {
  let value = address.split('%')[0]!.toLowerCase();
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255)) return null;
    value = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** The IPv4 address a well-known-prefix NAT64 address (64:ff9b::/96) embeds. */
function nat64Embedded(address: string): string | null {
  const g = ipv6Groups(address);
  if (!g || g[0] !== 0x64 || g[1] !== 0xff9b || g.slice(2, 6).some((x) => x !== 0)) return null;
  return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join('.');
}

/** True for any address an upstream must never be: also for anything that is not an IP at all. */
export function isBlockedAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(value);
  if (family === 4) return BLOCKED_V4.check(value, 'ipv4');
  if (family !== 6) return true;
  if (BLOCKED_V6.check(value, 'ipv6')) return true;
  const embedded = nat64Embedded(value);
  return embedded !== null && BLOCKED_V4.check(embedded, 'ipv4');
}

/** Lower-case, unbracketed, without a trailing dot: how policy sets store a host. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** Hosts listed comma- or space-separated, normalised. */
export function parseHostList(raw: string | undefined | null): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[\s,]+/)
      .map(normalizeHost)
      .filter(Boolean),
  );
}

/** The hosts of this orchestrator's own public URLs; unparseable entries are skipped. */
export function ownHostsFrom(...urls: Array<string | undefined | null>): Set<string> {
  const hosts = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    try {
      hosts.add(normalizeHost(new URL(url).hostname));
    } catch {
      /* not a URL: nothing to protect */
    }
  }
  return hosts;
}

/**
 * Validate and canonicalise an admin-supplied upstream base URL. Returns
 * `scheme://host[:port]/path` without a trailing slash.
 */
export function parseBaseUrl(raw: unknown, policy: UpstreamNetworkPolicy): string {
  if (typeof raw !== 'string') throw new InvalidBaseUrlError('base_url must be a string');
  const value = raw.trim();
  if (value === '') throw new InvalidBaseUrlError('base_url must not be empty');
  if (value.length > MAX_BASE_URL_LENGTH) throw new InvalidBaseUrlError(`base_url must be at most ${MAX_BASE_URL_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(value)) throw new InvalidBaseUrlError('base_url must not contain whitespace, control characters or backslashes');
  if (value.includes('?') || value.includes('#')) throw new InvalidBaseUrlError('base_url must not have a query or fragment');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidBaseUrlError('base_url must be an absolute URL');
  }
  if (url.username !== '' || url.password !== '')
    throw new InvalidBaseUrlError('base_url must not contain credentials');
  const host = normalizeHost(url.hostname);
  if (host === '') throw new InvalidBaseUrlError('base_url must name a host');
  const exempt = policy.privateHosts.has(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && exempt))
    throw new InvalidBaseUrlError('base_url must use https');
  if (policy.ownHosts.has(host)) throw new InvalidBaseUrlError('base_url must not point at this orchestrator');
  if (!exempt) {
    if (isIP(host) && isBlockedAddress(host)) throw new InvalidBaseUrlError('base_url points at a private or reserved address');
    if (host === 'localhost' || host.endsWith('.localhost')) throw new InvalidBaseUrlError('base_url points at a private or reserved address');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolver = (hostname: string, options: LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/**
 * A `net`/`tls` `lookup` that resolves every address and refuses the
 * connection when any of them is blocked. Exempt hosts are resolved normally.
 */
export function createGuardedLookup(policy: UpstreamNetworkPolicy, resolve: Resolver = dnsLookup as unknown as Resolver) {
  return function guardedLookup(hostname: string, options: object | LookupCallback, callback?: LookupCallback): void {
    const done = (typeof options === 'function' ? options : callback) as LookupCallback;
    const opts = (typeof options === 'function' ? {} : options) as { all?: boolean; family?: number; hints?: number };
    resolve(hostname, { family: opts.family, hints: opts.hints, all: true } as LookupAllOptions, (err, addresses) => {
      if (err) return done(err, []);
      const list = Array.isArray(addresses) ? addresses : [];
      if (!policy.privateHosts.has(normalizeHost(hostname)) && (list.length === 0 || list.some((entry) => isBlockedAddress(entry.address))))
        return done(new UpstreamAddressBlockedError() as unknown as NodeJS.ErrnoException, []);
      if (opts.all) return done(null, list);
      const first = list[0]!;
      done(null, first.address, first.family);
    });
  };
}

/** The undici connector every upstream socket (forward and verification) goes through. */
export function createGuardedConnector(
  policy: UpstreamNetworkPolicy,
  options: { connectTimeoutMs: number; resolve?: Resolver },
): buildConnector.connector {
  const connect = buildConnector({
    timeout: options.connectTimeoutMs,
    lookup: createGuardedLookup(policy, options.resolve),
  } as buildConnector.BuildOptions);
  return (opts, callback) => {
    const host = normalizeHost(opts.hostname);
    const exempt = policy.privateHosts.has(host);
    if (!exempt && (opts.protocol !== 'https:' || (isIP(host) !== 0 && isBlockedAddress(host)) || policy.ownHosts.has(host))) {
      callback(new UpstreamAddressBlockedError(), null);
      return;
    }
    connect(opts, callback);
  };
}

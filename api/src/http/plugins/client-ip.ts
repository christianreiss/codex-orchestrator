import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import ipaddr from 'ipaddr.js';
import type { Env } from '../../env.js';

declare module 'fastify' {
  interface FastifyRequest {
    clientIp: string;
  }
}

/**
 * Resolves the real client IP, honouring X-Forwarded-For only when the direct
 * caller is inside one of the configured trusted proxy CIDRs.
 */
export function makeClientIpPlugin(env: Env) {
  const trustForwarded = env.TRUST_X_FORWARDED;
  const cidrs = parseCidrs(env.TRUSTED_PROXY_CIDRS);

  return fp(
    async function clientIpPlugin(app: FastifyInstance) {
      app.decorateRequest('clientIp', '');

      app.addHook('onRequest', async (req) => {
        req.clientIp = resolveClientIp(req, trustForwarded, cidrs);
      });
    },
    { name: 'client-ip' },
  );
}

/**
 * "Is the direct caller a proxy we told this server to believe?" — the same
 * question `resolveClientIp` asks before honouring `X-Forwarded-For`, exported
 * because every other header a front proxy injects on our behalf needs the
 * identical answer. `auth-mtls` uses it to decide whether `X-MTLS-*` is
 * testimony from our own edge or something a client typed.
 *
 * Fails closed twice over: no `TRUST_X_FORWARDED`, or no CIDRs to match against,
 * means nothing is trusted. An allowlist that is empty by accident must not read
 * as "trust everyone".
 */
export function makeTrustedProxyCheck(env: Env): (req: FastifyRequest) => boolean {
  const trustForwarded = env.TRUST_X_FORWARDED;
  const cidrs = parseCidrs(env.TRUSTED_PROXY_CIDRS);

  return (req) => {
    if (!trustForwarded || cidrs.length === 0) return false;
    return ipMatches(normaliseIp(req.socket.remoteAddress ?? ''), cidrs);
  };
}

interface ParsedCidr {
  range: [ipaddr.IPv4 | ipaddr.IPv6, number];
}

function parseCidrs(raw: string): ParsedCidr[] {
  if (!raw.trim()) return [];
  const out: ParsedCidr[] = [];
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

function resolveClientIp(
  req: FastifyRequest,
  trustForwarded: boolean,
  cidrs: ParsedCidr[],
): string {
  const direct = normaliseIp(req.socket.remoteAddress ?? '') || '0.0.0.0';
  if (!trustForwarded) return direct;
  // Fail closed: with no trusted proxy CIDRs configured, never trust XFF.
  if (cidrs.length === 0 || !ipMatches(direct, cidrs)) return direct;

  const xff = headerOne(req, 'x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return normaliseIp(first);
  }
  const real = headerOne(req, 'x-real-ip');
  if (real) return normaliseIp(real);
  return direct;
}

function headerOne(req: FastifyRequest, key: string): string | undefined {
  const v = req.headers[key];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' && v.length ? v : undefined;
}

function normaliseIp(s: string): string {
  if (!s) return s;
  // Strip IPv6-mapped IPv4 (::ffff:1.2.3.4)
  if (s.startsWith('::ffff:')) return s.slice(7);
  // Strip [v6]:port or ip:port if present
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end !== -1) return s.slice(1, end);
  }
  return s;
}

function ipMatches(ip: string, cidrs: ParsedCidr[]): boolean {
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

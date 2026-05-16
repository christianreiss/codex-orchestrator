/**
 * Port of App\Services\ReverseDnsValidator.
 *
 * Validates an IP against a host's FQDN using forward+reverse DNS:
 *   - PTR for the IP must resolve to the FQDN (case-insensitive, dot-trimmed)
 *   - Forward A/AAAA for the FQDN must contain the IP
 *
 * Both must match. Failure is a 403 with `reverse_dns_mismatch`.
 *
 * The PHP version is synchronous via `dns_get_record`; this TS version uses
 * `node:dns/promises`. The host-side `reverse_dns_mode` tinyint stays the same
 * (null = follow fleet flag, 1 = always enforce, 0 = always skip).
 */
import { promises as dns } from 'node:dns';
import net from 'node:net';
import { ForbiddenError } from '../http/errors.js';

export type ReverseDnsModeInput = 'global' | 'enabled' | 'disabled';

export function parseReverseDnsModeInput(raw: unknown): ReverseDnsModeInput | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw ? 'enabled' : 'disabled';
  if (typeof raw === 'number') {
    if (raw === 0) return 'disabled';
    if (raw === 1) return 'enabled';
    return null;
  }
  if (typeof raw !== 'string') return null;
  const v = raw.toLowerCase().trim();
  if (v === '' || v === 'global' || v === 'default' || v === 'fleet') return 'global';
  if (['1', 'true', 't', 'yes', 'y', 'on', 'enabled', 'enable'].includes(v)) return 'enabled';
  if (['0', 'false', 'f', 'no', 'n', 'off', 'disabled', 'disable'].includes(v)) return 'disabled';
  return null;
}

export function modeStringToTinyint(mode: ReverseDnsModeInput): number | null {
  if (mode === 'global') return null;
  return mode === 'enabled' ? 1 : 0;
}

export function tinyintToModeString(value: number | null | undefined): ReverseDnsModeInput {
  if (value === null || value === undefined) return 'global';
  return value === 0 ? 'disabled' : 'enabled';
}

export function normalizeHostname(hostname: string | null | undefined): string | null {
  if (typeof hostname !== 'string') return null;
  const trimmed = hostname.toLowerCase().trim().replace(/\.+$/, '');
  return trimmed === '' ? null : trimmed;
}

export function normalizeIp(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  if (!trimmed) return null;
  if (net.isIPv4(trimmed)) return trimmed;
  if (net.isIPv6(trimmed)) {
    // Map ::ffff:1.2.3.4 down to v4
    const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(trimmed);
    if (m && m[1] && net.isIPv4(m[1])) return m[1];
    return trimmed.toLowerCase();
  }
  return null;
}

export async function resolveForwardIps(fqdn: string): Promise<string[]> {
  const out = new Set<string>();
  await Promise.all([
    dns
      .resolve4(fqdn)
      .then((ips) => {
        for (const ip of ips) {
          const n = normalizeIp(ip);
          if (n) out.add(n);
        }
      })
      .catch(() => undefined),
    dns
      .resolve6(fqdn)
      .then((ips) => {
        for (const ip of ips) {
          const n = normalizeIp(ip);
          if (n) out.add(n);
        }
      })
      .catch(() => undefined),
  ]);
  return Array.from(out);
}

export async function resolvePtrHosts(ip: string): Promise<string[]> {
  const out = new Set<string>();
  try {
    const targets = await dns.reverse(ip);
    for (const t of targets) {
      const n = normalizeHostname(t);
      if (n) out.add(n);
    }
  } catch {
    /* no PTR */
  }
  return Array.from(out);
}

export interface ReverseDnsCheckResult {
  match: boolean;
  forwardMatch: boolean;
  ptrMatch: boolean;
  forwardIps: string[];
  ptrHosts: string[];
}

export async function validateReverseDns(
  fqdn: string,
  ip: string,
): Promise<ReverseDnsCheckResult> {
  const normalizedFqdn = normalizeHostname(fqdn);
  const normalizedIp = normalizeIp(ip);
  if (!normalizedFqdn || !normalizedIp) {
    return { match: false, forwardMatch: false, ptrMatch: false, forwardIps: [], ptrHosts: [] };
  }

  const [forwardIps, ptrHosts] = await Promise.all([
    resolveForwardIps(normalizedFqdn),
    resolvePtrHosts(normalizedIp),
  ]);
  const forwardMatch = forwardIps.includes(normalizedIp);
  const ptrMatch = ptrHosts.some((h) => h === normalizedFqdn);
  return {
    match: forwardMatch && ptrMatch,
    forwardMatch,
    ptrMatch,
    forwardIps,
    ptrHosts,
  };
}

export async function assertReverseDnsMatch(fqdn: string, ip: string): Promise<void> {
  const result = await validateReverseDns(fqdn, ip);
  if (!result.match) {
    throw new ForbiddenError('Reverse DNS check failed', 'reverse_dns_mismatch');
  }
}

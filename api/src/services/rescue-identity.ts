import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Host } from '../db/schema.js';
import { UnauthorizedError, ServiceUnavailableError } from '../http/errors.js';

export function isRescueMediaHost(host: Pick<Host, 'fqdn' | 'secure' | 'vip'>): boolean {
  return host.secure === 0 && !host.vip && ['rescue-owl', 'rescue-dalason'].includes(host.fqdn);
}

export function verifyRescueToken(id: number, hostKey: string, presented: string): boolean {
  const prefix = `rescue1.${id}`;
  const digest = createHmac('sha256', hostKey).update(prefix).digest('hex');
  const expected = Buffer.from(`${prefix}.${digest}`);
  const received = Buffer.from(presented);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function rescueHostId(token: string): number {
  const match = /^rescue1\.([1-9]\d{0,9})\.[a-f0-9]{64}$/.exec(token);
  if (!match) throw new UnauthorizedError('Invalid rescue identity');
  return Number(match[1]);
}

// Never return a refresh token, general API key, canonical auth object or MCP credential.
export function rescueAccess(engine: 'codex' | 'claude', auth: Record<string, unknown> | null) {
  const tokens = auth?.[engine === 'codex' ? 'tokens' : 'claudeAiOauth'] as Record<string, unknown> | undefined;
  const access = tokens?.[engine === 'codex' ? 'access_token' : 'accessToken'];
  if (typeof access !== 'string' || !access) throw new ServiceUnavailableError('No verified OAuth account for rescue', 'account_unavailable');
  if (engine === 'claude') return { access_token: access };
  return {
    access_token: access,
    id_token: typeof tokens?.id_token === 'string' ? tokens.id_token : '',
    account_id: typeof tokens?.account_id === 'string' ? tokens.account_id : undefined,
  };
}

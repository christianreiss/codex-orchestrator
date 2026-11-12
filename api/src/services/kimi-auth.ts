import { createHash } from 'node:crypto';
import { hostname, release, type, arch } from 'node:os';
import { ValidationError } from '../http/errors.js';
import { isRfc3339 } from '../util/timestamp.js';

export const KIMI_OIDC_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
export const KIMI_AUTH_TARGET = 'api.kimi.com';
export const KIMI_MIN_CLIENT_VERSION = '2.5.3';
export interface KimiCredential {
  native: Record<string, unknown>;
  access: string;
  refresh: string | null;
  issuedAt: string;
  expiresAt: string;
  expiresIn: number;
  clientId: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function selectKimiCredential(
  auth: Record<string, unknown>,
  allowProjection = false,
): KimiCredential | null {
  const native = auth.kimi_code;
  if (
    !record(native) ||
    typeof native.access_token !== 'string' ||
    native.access_token.trim().length < 8 ||
    native.access_token !== native.access_token.trim()
  )
    return null;
  if (
    typeof auth.device_id !== 'string' ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(auth.device_id)
  )
    return null;
  if (typeof auth.last_refresh !== 'string' || !isRfc3339(auth.last_refresh)) return null;
  if (
    typeof native.expires_at !== 'number' ||
    !Number.isFinite(native.expires_at) ||
    (native.expires_at <= 0 && !(allowProjection && native.expires_at === 0))
  )
    return null;
  if (
    typeof native.expires_in !== 'number' ||
    !Number.isFinite(native.expires_in) ||
    (native.expires_in <= 0 && !(allowProjection && native.expires_in === 0))
  )
    return null;
  if (native.expires_at * 1000 > 8640000000000000) return null;
  const expiresAt =
    native.expires_at === 0 ? '9999-12-31T23:59:59.000Z' : new Date(native.expires_at * 1000).toISOString();
  return {
    native,
    access: native.access_token,
    refresh:
      typeof native.refresh_token === 'string' && native.refresh_token.trim() ? native.refresh_token : null,
    issuedAt: auth.last_refresh,
    expiresAt,
    expiresIn: native.expires_in,
    clientId: KIMI_OIDC_CLIENT_ID,
  };
}
export function normalizeKimiAuth(
  auth: Record<string, unknown>,
  requireRefresh = false,
): Record<string, unknown> {
  const selected = selectKimiCredential(auth);
  if (!selected || (requireRefresh && !selected.refresh))
    throw new ValidationError(
      'Kimi requires a dedicated device login including device_id and refresh token',
      { param: 'auth' },
    );
  const oauthHost = auth.oauth_host ?? 'https://auth.kimi.com';
  const baseUrl = auth.base_url ?? 'https://api.kimi.com/coding/v1';
  if (
    !['https://auth.kimi.com', 'https://auth.kimi.ai'].includes(String(oauthHost)) ||
    !['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1'].includes(String(baseUrl))
  )
    throw new ValidationError('Kimi OAuth and API origins must name the official regional endpoints', {
      param: 'auth',
    });
  return {
    last_refresh: auth.last_refresh,
    device_id: auth.device_id,
    oauth_host: oauthHost,
    base_url: baseUrl,
    kimi_code: {
      access_token: selected.access,
      refresh_token: selected.refresh ?? '',
      expires_at: selected.native.expires_at,
      expires_in: selected.expiresIn,
      scope: typeof selected.native.scope === 'string' ? selected.native.scope : 'kimi-code',
      token_type: 'Bearer',
    },
    auths: { [KIMI_AUTH_TARGET]: { token: selected.access, token_type: 'bearer' } },
  };
}
/** Whitelist fields so unrelated credentials cannot reach a runtime. */
export function projectKimiAuth(auth: Record<string, unknown>): Record<string, unknown> {
  const selected = selectKimiCredential(auth, true);
  if (!selected) throw new ValidationError('Kimi canonical credential is invalid', { param: 'auth' });
  return {
    last_refresh: auth.last_refresh,
    device_id: auth.device_id,
    oauth_host: auth.oauth_host,
    base_url: auth.base_url,
    kimi_code: {
      access_token: selected.access,
      refresh_token: '',
      expires_at: 0,
      expires_in: 0,
      scope: selected.native.scope ?? 'kimi-code',
      token_type: 'Bearer',
    },
    auths: { [KIMI_AUTH_TARGET]: { token: selected.access, token_type: 'bearer' } },
  };
}
/**
 * Access-only payload for the auth runner. Unlike the host projection it keeps
 * the real expiry: the runner refuses tokens it cannot prove are still fresh,
 * and never refreshes them itself (the server is the single refresher).
 */
export function projectKimiRunnerAuth(auth: Record<string, unknown>): Record<string, unknown> {
  const selected = selectKimiCredential(auth, true);
  if (!selected) throw new ValidationError('Kimi canonical credential is invalid', { param: 'auth' });
  const projected = projectKimiAuth(auth);
  const native = projected.kimi_code as Record<string, unknown>;
  return {
    ...projected,
    kimi_code: { ...native, expires_at: selected.native.expires_at, expires_in: selected.expiresIn },
  };
}
export function kimiProjectionMetadata(auth: Record<string, unknown>) {
  const selected = selectKimiCredential(auth);
  return selected
    ? {
        access_token_digest: createHash('sha256').update(selected.access).digest('hex'),
        expires_at: selected.expiresAt,
      }
    : {};
}
export function kimiDeviceHeaders(deviceId: string): Record<string, string> {
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, '').trim() || 'unknown';
  return {
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': KIMI_MIN_CLIENT_VERSION,
    'X-Msh-Device-Id': deviceId,
    'X-Msh-Device-Name': ascii(hostname()),
    'X-Msh-Device-Model': ascii(`${type()} ${release()} ${arch()}`),
    'X-Msh-Os-Version': ascii(release()),
  };
}

import { createHash } from 'node:crypto';
import { ValidationError } from '../http/errors.js';
import { isRfc3339 } from '../util/timestamp.js';

export const GROK_OIDC_ISSUER = 'https://auth.x.ai';
export const GROK_OIDC_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_AUTH_SCOPE = `${GROK_OIDC_ISSUER}::${GROK_OIDC_CLIENT_ID}`;
export const GROK_AUTH_TARGET = 'cli-chat-proxy.grok.com';
export const GROK_USER_URL = `https://${GROK_AUTH_TARGET}/v1/user?include=subscription`;

export interface GrokCredential {
  scope: string;
  native: Record<string, unknown>;
  access: string;
  refresh: string | null;
  issuedAt: string;
  expiresAt: string;
  clientId: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function grokNativeAuth(auth: Record<string, unknown>): Record<string, unknown> {
  return record(auth.grok_auth) ? auth.grok_auth : auth;
}

/** Pinned Grok Build uses the default issuer/client scope; retain all other scopes verbatim. */
export function selectGrokCredential(auth: Record<string, unknown>, allowExternal = false): GrokCredential | null {
  const map = grokNativeAuth(auth);
  const native = map[GROK_AUTH_SCOPE];
  if (!record(native)) return null;
  if (native.auth_mode !== 'oidc' && !(allowExternal && native.auth_mode === 'external')) return null;
  if (native.oidc_issuer !== undefined && native.oidc_issuer !== GROK_OIDC_ISSUER) return null;
  if (native.oidc_client_id !== undefined && native.oidc_client_id !== GROK_OIDC_CLIENT_ID) return null;
  if (typeof native.key !== 'string' || native.key.trim().length < 8 || native.key !== native.key.trim()) return null;
  if (typeof native.create_time !== 'string' || !isRfc3339(native.create_time)) return null;
  if (typeof native.expires_at !== 'string' || !isRfc3339(native.expires_at)) return null;
  const expiresAt = native.expires_at;
  return {
    scope: GROK_AUTH_SCOPE,
    native,
    access: native.key,
    refresh: typeof native.refresh_token === 'string' && native.refresh_token.trim() ? native.refresh_token : null,
    issuedAt: native.create_time,
    expiresAt,
    clientId: GROK_OIDC_CLIENT_ID,
  };
}

export function normalizeGrokAuth(auth: Record<string, unknown>, requireRefresh = false): Record<string, unknown> {
  const selected = selectGrokCredential(auth);
  if (!selected) throw new ValidationError('Grok requires a modern xAI OAuth subscription login; legacy web login and runtime projections must be replaced with a new login', { param: 'auth' });
  if (requireRefresh && !selected.refresh) throw new ValidationError('Grok subscription login is missing its refresh token; log in again', { param: 'auth' });
  const lastRefresh = typeof auth.last_refresh === 'string' && isRfc3339(auth.last_refresh) ? auth.last_refresh : selected.issuedAt;
  return {
    last_refresh: lastRefresh,
    auths: { [GROK_AUTH_TARGET]: { token: selected.access, token_type: 'bearer' } },
    grok_scope: selected.scope,
    grok_auth: structuredClone(grokNativeAuth(auth)),
  };
}

/** No scope, including an unselected scope, may leak refresh material to a host/runner. */
export function projectGrokAuth(auth: Record<string, unknown>): Record<string, unknown> {
  const selected = selectGrokCredential(auth, true);
  if (!selected) throw new ValidationError('Grok canonical credential is invalid', { param: 'auth' });
  const native = structuredClone(grokNativeAuth(auth));
  for (const [scope, value] of Object.entries(native)) {
    if (!record(value)) continue;
    delete value.refresh_token;
    // Other login scopes may carry independent provider credentials. The runtime
    // can use only the centrally selected OAuth account, never those secrets.
    if (scope !== selected.scope) delete value.key;
  }
  const credential = native[selected.scope] as Record<string, unknown>;
  credential.auth_mode = 'external';
  credential.oidc_issuer = GROK_OIDC_ISSUER;
  credential.oidc_client_id = selected.clientId;
  credential.expires_at = selected.expiresAt;
  return {
    last_refresh: auth.last_refresh ?? selected.issuedAt,
    auths: { [GROK_AUTH_TARGET]: { token: selected.access, token_type: 'bearer' } },
    grok_scope: selected.scope,
    grok_auth: native,
  };
}

export function grokProjectionMetadata(auth: Record<string, unknown>) {
  const selected = selectGrokCredential(auth, true);
  if (!selected) return {};
  return { access_token_digest: createHash('sha256').update(selected.access).digest('hex'), expires_at: selected.expiresAt };
}

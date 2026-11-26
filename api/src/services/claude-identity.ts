import { createHash } from 'node:crypto';

/**
 * Claude OAuth credentials carry no account identity, so two different
 * subscriptions look alike. The server asks Anthropic's OAuth profile endpoint
 * (the same call Claude Code makes after a login) who an access token belongs
 * to. This is the only server-side Anthropic call made with a user OAuth token:
 * it never refreshes and never runs inference.
 */
export interface ClaudeIdentity {
  accountUuid: string;
  organizationUuid: string;
  email: string | null;
  organizationName: string | null;
}

export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 512;

type FetchLike = typeof fetch;
let fetchImpl: FetchLike | null = null;
const cache = new Map<string, { at: number; identity: ClaudeIdentity | null }>();

/** Tests inject a fake transport; `null` restores the global fetch. */
export function setClaudeIdentityFetch(impl: FetchLike | null): void {
  fetchImpl = impl;
  cache.clear();
}

/** Stable value fed into `providerIdentity` (hashed there with the engine). */
export function claudeIdentityValue(identity: ClaudeIdentity): string {
  return `${identity.accountUuid}:${identity.organizationUuid}`;
}

function tokenKey(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('hex');
}

function parseProfile(body: unknown): ClaudeIdentity | null {
  if (!body || typeof body !== 'object') return null;
  const doc = body as { account?: Record<string, unknown>; organization?: Record<string, unknown> };
  const accountUuid = doc.account?.uuid;
  const organizationUuid = doc.organization?.uuid;
  if (typeof accountUuid !== 'string' || !accountUuid || typeof organizationUuid !== 'string' || !organizationUuid)
    return null;
  const email = doc.account?.email ?? doc.account?.email_address;
  const name = doc.organization?.name;
  return {
    accountUuid,
    organizationUuid,
    email: typeof email === 'string' && email ? email : null,
    organizationName: typeof name === 'string' && name ? name : null,
  };
}

/**
 * Resolve the identity behind a Claude OAuth access token. Returns null when the
 * token is expired/revoked or Anthropic is unreachable; callers then keep the
 * lineage-based behaviour. Results are cached per token digest.
 */
export async function resolveClaudeIdentity(accessToken: string | null | undefined): Promise<ClaudeIdentity | null> {
  if (typeof accessToken !== 'string' || !accessToken.startsWith('sk-ant-oat')) return null;
  // Test suites use fabricated tokens; they opt in by injecting a transport.
  if (!fetchImpl && process.env.VITEST) return null;
  const key = tokenKey(accessToken);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.identity ? TTL_MS : NEGATIVE_TTL_MS)) return hit.identity;
  let identity: ClaudeIdentity | null = null;
  try {
    const response = await (fetchImpl ?? fetch)(CLAUDE_PROFILE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      identity = parseProfile(await response.json());
      // A 2xx without the expected fields means the profile shape changed:
      // stores silently fall back to lineage, which merges subscriptions.
      if (!identity) console.warn('claude identity: profile response lacks account/organization uuid');
    } else if (response.status !== 401 && response.status !== 403) {
      console.warn(`claude identity: profile lookup returned HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn('claude identity: profile lookup failed', error instanceof Error ? error.message : String(error));
    identity = null;
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), identity });
  return identity;
}

/** Access token of a Claude canonical/native payload, if present. */
export function claudeAccessToken(auth: Record<string, unknown>): string | null {
  const oauth = auth.claudeAiOauth as Record<string, unknown> | undefined;
  const token = oauth?.accessToken;
  return typeof token === 'string' ? token : null;
}

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

/**
 * Outcome of one identity lookup. Callers must not treat the two failures
 * alike: `unidentifiable` is Anthropic's own answer (the access token is
 * expired or revoked, HTTP 401/403), while `unavailable` says nothing about
 * the token (timeout, network error, 429, 5xx, an unexpected profile shape).
 * `skipped` is a credential the endpoint is never asked about (API keys, and
 * fabricated tokens in test runs without an injected transport).
 */
export type ClaudeIdentityLookup =
  | { status: 'resolved'; identity: ClaudeIdentity }
  | { status: 'unidentifiable' }
  | { status: 'unavailable'; reason: string }
  | { status: 'skipped' };

export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const TTL_MS = 6 * 60 * 60 * 1000;
/** Anthropic's own refusals (401/403) and rate limits (429) are not asked again for a minute. */
const NEGATIVE_TTL_MS = 60 * 1000;
/** Any other failure only collapses concurrent retries; the next store asks again. */
const TRANSIENT_TTL_MS = 10 * 1000;
const MAX_ENTRIES = 512;

type FetchLike = typeof fetch;
let fetchImpl: FetchLike | null = null;
const cache = new Map<string, { at: number; ttl: number; lookup: ClaudeIdentityLookup }>();

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
 * Ask Anthropic who a Claude OAuth access token belongs to. Results are cached
 * per token digest: an identity for six hours, a refusal or a rate limit for a
 * minute, any other failure for ten seconds.
 */
export async function lookupClaudeIdentity(accessToken: string | null | undefined): Promise<ClaudeIdentityLookup> {
  if (typeof accessToken !== 'string' || !accessToken.startsWith('sk-ant-oat')) return { status: 'skipped' };
  // Test suites use fabricated tokens; they opt in by injecting a transport.
  if (!fetchImpl && process.env.VITEST) return { status: 'skipped' };
  const key = tokenKey(accessToken);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.lookup;
  let lookup: ClaudeIdentityLookup;
  let ttl = TRANSIENT_TTL_MS;
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
      const identity = parseProfile(await response.json());
      if (identity) {
        lookup = { status: 'resolved', identity };
        ttl = TTL_MS;
      } else {
        // A 2xx without the expected fields means the profile shape changed.
        console.warn('claude identity: profile response lacks account/organization uuid');
        lookup = { status: 'unavailable', reason: 'profile_shape' };
      }
    } else if (response.status === 401 || response.status === 403) {
      lookup = { status: 'unidentifiable' };
      ttl = NEGATIVE_TTL_MS;
    } else {
      console.warn(`claude identity: profile lookup returned HTTP ${response.status}`);
      lookup = { status: 'unavailable', reason: `http_${response.status}` };
      if (response.status === 429) ttl = NEGATIVE_TTL_MS;
    }
  } catch (error) {
    console.warn('claude identity: profile lookup failed', error instanceof Error ? error.message : String(error));
    lookup = {
      status: 'unavailable',
      reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network',
    };
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), ttl, lookup });
  return lookup;
}

/** The identity behind a token, or null for every other lookup outcome. */
export async function resolveClaudeIdentity(accessToken: string | null | undefined): Promise<ClaudeIdentity | null> {
  const lookup = await lookupClaudeIdentity(accessToken);
  return lookup.status === 'resolved' ? lookup.identity : null;
}

/** Access token of a Claude canonical/native payload, if present. */
export function claudeAccessToken(auth: Record<string, unknown>): string | null {
  const oauth = auth.claudeAiOauth as Record<string, unknown> | undefined;
  const token = oauth?.accessToken;
  return typeof token === 'string' ? token : null;
}

/**
 * Header policy of the upstream forward, an allowlist in both directions.
 *
 * Toward the provider only what a client SDK legitimately says about its
 * request goes out; the client's credential (`authorization`, `x-api-key`),
 * cookies, `openai-organization` / `openai-project` (they would select another
 * tenant's billing scope on our key) and every hop-by-hop or proxy header are
 * dropped, and the provider key is added as the provider's own auth header.
 *
 * Toward the client only response metadata an SDK reads comes back: content
 * metadata, retry and rate-limit hints, and the provider's request id (which
 * replaces ours so provider support can find the call; ours moves to
 * `x-gateway-request-id`). Account-revealing headers such as
 * `openai-organization`, `openai-project`, `set-cookie` and CDN/server
 * identification are stripped.
 */
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { ANTHROPIC_DEFAULT_VERSION, providerAuthHeaders, type ProviderId } from './providers.js';

const REQUEST_COMMON = new Set(['accept', 'accept-encoding', 'content-type', 'user-agent', 'idempotency-key', 'x-client-request-id']);
const REQUEST_ANTHROPIC = new Set(['anthropic-version', 'anthropic-beta']);
const REQUEST_OPENAI_WIRE = new Set(['openai-beta']);
const REQUEST_PREFIXES = ['x-stainless-'];

const RESPONSE_ALLOWED = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
  'retry-after',
  'retry-after-ms',
  'x-should-retry',
  'request-id',
  'x-request-id',
  'openai-processing-ms',
  'openai-version',
]);
const RESPONSE_PREFIXES = ['x-ratelimit-', 'anthropic-ratelimit-'];

/** Our own reply headers that the upstream response always owns. */
const OURS_REPLACED = new Set(['content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

export const GATEWAY_REQUEST_ID_HEADER = 'x-gateway-request-id';

function joined(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * The provider request headers for one attempt. `contentLength` is set for a
 * streamed body; a buffered body gets its length from undici.
 */
export function upstreamRequestHeaders(
  inbound: IncomingHttpHeaders,
  provider: ProviderId,
  key: string,
  options: { contentLength?: number | null } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(inbound)) {
    const name = rawName.toLowerCase();
    const allowed =
      REQUEST_COMMON.has(name) ||
      (provider === 'anthropic' ? REQUEST_ANTHROPIC.has(name) : REQUEST_OPENAI_WIRE.has(name)) ||
      REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix));
    const value = joined(rawValue);
    if (allowed && value !== undefined) out[name] = value;
  }
  if (provider === 'anthropic' && !out['anthropic-version']) out['anthropic-version'] = ANTHROPIC_DEFAULT_VERSION;
  if (options.contentLength != null) out['content-length'] = String(options.contentLength);
  return { ...out, ...providerAuthHeaders(provider, key) };
}

/** True when the provider response header may reach the client. */
export function isForwardedResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return RESPONSE_ALLOWED.has(lower) || RESPONSE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * The client response headers: ours (CORS, request id, version) first, then
 * the allowed provider headers on top, plus `x-gateway-request-id`.
 */
export function clientResponseHeaders(
  upstream: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  ours: OutgoingHttpHeaders | Record<string, string | number | string[] | undefined>,
  gatewayRequestId: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(ours)) {
    if (value === undefined || OURS_REPLACED.has(name.toLowerCase())) continue;
    out[name.toLowerCase()] = typeof value === 'number' ? String(value) : value;
  }
  for (const [name, value] of Object.entries(upstream)) {
    if (value === undefined || !isForwardedResponseHeader(name)) continue;
    out[name.toLowerCase()] = value;
  }
  out[GATEWAY_REQUEST_ID_HEADER] = gatewayRequestId;
  return out;
}

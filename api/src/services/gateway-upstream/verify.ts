/**
 * Key verification: `GET {base}/models`, free on every provider, through the
 * same guarded agent as the forward (so a verification cannot reach an
 * address a forward could not). 2xx → `valid`, 401/403 → `invalid`, anything
 * else → `error`. The response body is discarded unread: only the status and a
 * fixed reason are kept (see `telemetry.ts`).
 */
import { request, type Dispatcher } from 'undici';
import { ANTHROPIC_DEFAULT_VERSION, providerAuthHeaders, type ProviderId } from './providers.js';
import { describeReason, reasonForStatus, type UpstreamReason } from './telemetry.js';

export type VerificationState = 'valid' | 'invalid' | 'error';

export interface VerificationResult {
  state: VerificationState;
  /** Fixed vocabulary plus HTTP status, e.g. `unauthorized (HTTP 401)`. */
  reason: string;
  status: number | null;
}

export const VERIFY_TIMEOUT_MS = 10_000;

/** Map a transport failure to the fixed vocabulary; never its message. */
export function reasonForError(err: unknown): UpstreamReason {
  const code = (err as { code?: unknown } | null)?.code;
  const name = (err as { name?: unknown } | null)?.name;
  if (code === 'EGATEWAYBLOCKED') return 'blocked_address';
  if (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    name === 'TimeoutError' ||
    code === 'ETIMEDOUT'
  )
    return 'timeout';
  return 'unreachable';
}

export async function verifyProviderKey(
  dispatcher: Dispatcher,
  provider: ProviderId,
  baseUrl: string,
  key: string,
  timeoutMs = VERIFY_TIMEOUT_MS,
): Promise<VerificationResult> {
  try {
    const response = await request(`${baseUrl}/models`, {
      method: 'GET',
      dispatcher,
      headers: {
        accept: 'application/json',
        ...(provider === 'anthropic' ? { 'anthropic-version': ANTHROPIC_DEFAULT_VERSION } : {}),
        ...providerAuthHeaders(provider, key),
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body.dump().catch(() => undefined);
    const status = response.statusCode;
    const reason = reasonForStatus(status);
    const state: VerificationState =
      status >= 200 && status < 300 ? 'valid' : status === 401 || status === 403 ? 'invalid' : 'error';
    return { state, reason: describeReason(reason, status), status };
  } catch (err) {
    return { state: 'error', reason: describeReason(reasonForError(err)), status: null };
  }
}

/**
 * Key verification: `GET {base}/models`, free on every provider, through the
 * same guarded agent as the forward (so a verification cannot reach an
 * address a forward could not).
 *
 * - 2xx → `valid`.
 * - 401/403 → `invalid`, unless the provider says the key authenticated but
 *   lacks a scope or permission (OpenAI restricted keys: "insufficient
 *   permissions … Missing scopes", Anthropic `permission_error`). That key is
 *   real and may serve other endpoints, so it stays `valid` with reason
 *   `restricted`.
 * - 400 from xAI whose body says the key is incorrect → `invalid` (xAI
 *   answers a wrong key with 400).
 * - Anything else, a refused address or a timeout → `error`.
 *
 * Only an error answer's first bytes are read, and only to choose among
 * these outcomes. The body is never stored, logged or returned: what is kept
 * is the status and a fixed reason (see `telemetry.ts`), because an
 * admin-chosen base URL plus an echoed body would be an SSRF oracle.
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
/** How much of an error answer is read to classify it. */
const CLASSIFY_BYTES = 16 * 1024;

const PERMISSION_ANSWER = /missing scopes?\b|insufficient (?:permissions|scopes?)|permission_error|permission_denied/i;
const WRONG_KEY_ANSWER = /incorrect api key|invalid api key/i;

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

/** The first `CLASSIFY_BYTES` of a body as text; the rest is discarded. */
async function head(body: Dispatcher.ResponseData['body']): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.from(chunk as Uint8Array);
      chunks.push(bytes);
      size += bytes.length;
      if (size >= CLASSIFY_BYTES) break;
    }
  } catch {
    /* a truncated body classifies as what it shows */
  } finally {
    body.destroy();
  }
  return Buffer.concat(chunks).subarray(0, CLASSIFY_BYTES).toString('utf8');
}

/** Classify a non-2xx answer without keeping any of it. */
export function classifyVerification(provider: ProviderId, status: number, text: string): VerificationResult {
  if (status === 401 || status === 403) {
    if (PERMISSION_ANSWER.test(text)) return { state: 'valid', reason: describeReason('restricted', status), status };
    return { state: 'invalid', reason: describeReason(reasonForStatus(status), status), status };
  }
  if (provider === 'xai' && status === 400 && WRONG_KEY_ANSWER.test(text))
    return { state: 'invalid', reason: describeReason('unauthorized', status), status };
  return { state: 'error', reason: describeReason(reasonForStatus(status), status), status };
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
    const status = response.statusCode;
    if (status >= 200 && status < 300) {
      await response.body.dump().catch(() => undefined);
      return { state: 'valid', reason: describeReason('ok', status), status };
    }
    return classifyVerification(provider, status, await head(response.body));
  } catch (err) {
    return { state: 'error', reason: describeReason(reasonForError(err)), status: null };
  }
}

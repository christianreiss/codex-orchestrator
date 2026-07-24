import type { ApiError } from '../errors.js';

/**
 * OpenAI returns the raw model body on success and wraps errors as
 *   { error: { message, type, code, param } }
 * This mirrors the PHP App\Http\OpenAiResponse helper.
 */

export interface OpenAiError {
  error: {
    message: string;
    type: string;
    code: string;
    param?: string;
  };
}

/**
 * The `error.type` values the real OpenAI API emits. Shared error classes in
 * this codebase can throw undocumented Anthropic/internal types
 * (`api_error`, `not_implemented`, `not_found_error`, `authentication_error`,
 * `service_unavailable`, `conflict_error`, `locked_error`, …); leaking those to
 * an OpenAI SDK client breaks its error classification, so anything outside the
 * documented set is remapped onto the type matching the HTTP status.
 *
 * Note: upstream OpenAI uses `invalid_request_error` for 401 (with
 * `code: "invalid_api_key"`) and 404 (`code: "model_not_found"`) — it does NOT
 * use `authentication_error`/`not_found_error` as `type` values the way the
 * Anthropic wire format does. Keeping this list narrow enforces that.
 */
const OPENAI_ERROR_TYPES = new Set([
  'invalid_request_error',
  'rate_limit_error',
  'insufficient_quota',
  'server_error',
]);

/** Fallback mapping for error types outside the documented set. */
function errorTypeForStatus(status: number): string {
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  // 400/401/403/404/413/422/501 all surface as invalid_request_error upstream.
  return 'invalid_request_error';
}

export function success<T>(data: T): T {
  return data;
}

export function failure(err: ApiError): OpenAiError {
  const type = OPENAI_ERROR_TYPES.has(err.type) ? err.type : errorTypeForStatus(err.status);
  const out: OpenAiError = {
    error: {
      message: err.message,
      type,
      code: err.code,
    },
  };
  if (err.param) out.error.param = err.param;
  return out;
}

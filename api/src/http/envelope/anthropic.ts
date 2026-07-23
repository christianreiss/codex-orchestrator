import type { ApiError } from '../errors.js';

/**
 * Anthropic wire format:
 *   { type: 'error', error: { type, message } }
 * Mirrors the PHP App\Http\AnthropicResponse helper.
 */

export interface AnthropicError {
  type: 'error';
  error: {
    type: string;
    message: string;
    code?: string;
  };
}

/**
 * The complete set of `error.type` values the Anthropic API documents. Clients
 * (and the official SDKs' error classification) switch on these, so anything
 * else leaking out of a shared error class must be mapped onto a documented
 * value before it reaches an `/anthropic/v1/*` caller.
 */
const ANTHROPIC_ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'overloaded_error',
]);

/** Fallback mapping for error types outside the documented set. */
function errorTypeForStatus(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

export function success<T>(data: T): T {
  return data;
}

export function failure(err: ApiError): AnthropicError {
  const type = ANTHROPIC_ERROR_TYPES.has(err.type) ? err.type : errorTypeForStatus(err.status);
  return {
    type: 'error',
    error: {
      type,
      message: err.message,
      code: err.code,
    },
  };
}

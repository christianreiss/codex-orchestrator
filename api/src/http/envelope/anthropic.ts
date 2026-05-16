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

export function success<T>(data: T): T {
  return data;
}

export function failure(err: ApiError): AnthropicError {
  return {
    type: 'error',
    error: {
      type: err.type,
      message: err.message,
      code: err.code,
    },
  };
}

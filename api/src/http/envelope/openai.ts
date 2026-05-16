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

export function success<T>(data: T): T {
  return data;
}

export function failure(err: ApiError): OpenAiError {
  const out: OpenAiError = {
    error: {
      message: err.message,
      type: err.type,
      code: err.code,
    },
  };
  if (err.param) out.error.param = err.param;
  return out;
}

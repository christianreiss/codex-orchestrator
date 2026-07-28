import { describe, it, expect } from 'vitest';
import { success, failure } from '../../../src/http/envelope/openai.js';
import {
  ApiError,
  ConflictError,
  LockedError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../../src/http/errors.js';

/**
 * An OpenAI SDK classifies failures off `error.type`, so this envelope narrows
 * `err.type` to the four documented values and remaps everything else onto the
 * type matching the HTTP status. The shared error classes throw Anthropic/
 * internal types (`api_error`, `authentication_error`, `not_found_error`,
 * `conflict_error`, `locked_error`, `service_unavailable`, …) from routes this
 * envelope serves, so widening the documented set or breaking the status
 * mapping would leak those to clients without failing a request-level suite.
 */

describe('OpenAI envelope error type narrowing', () => {
  it('passes the documented types through even when the status maps elsewhere', () => {
    // Each status here would produce a *different* type via the fallback, so a
    // match proves pass-through rather than a coincidence of the mapping.
    const cases: Array<[string, number]> = [
      ['invalid_request_error', 500],
      ['rate_limit_error', 400],
      ['insufficient_quota', 429],
      ['server_error', 400],
    ];
    for (const [type, status] of cases) {
      expect(failure(new ApiError('x', { status, type, code: 'c' }))).toEqual({
        error: { message: 'x', type, code: 'c' },
      });
    }
  });

  it('remaps undocumented types onto the type matching the HTTP status', () => {
    const cases: Array<[string, number, string]> = [
      ['api_error', 429, 'rate_limit_error'],
      ['api_error', 500, 'server_error'],
      ['service_unavailable', 503, 'server_error'],
      ['api_error', 400, 'invalid_request_error'],
      ['authentication_error', 401, 'invalid_request_error'],
      ['permission_error', 403, 'invalid_request_error'],
      ['not_found_error', 404, 'invalid_request_error'],
      ['request_too_large', 413, 'invalid_request_error'],
      ['unprocessable_entity', 422, 'invalid_request_error'],
      // 501 hits the `status >= 500` branch, so it lands on server_error —
      // *not* the invalid_request_error the comment in openai.ts lists it under.
      ['not_implemented', 501, 'server_error'],
    ];
    for (const [type, status, expected] of cases) {
      expect(failure(new ApiError('x', { status, type, code: 'c' }))).toEqual({
        error: { message: 'x', type: expected, code: 'c' },
      });
    }
  });

  it('remaps the real error classes an OpenAI route can throw, keeping message and code', () => {
    const cases: Array<[ApiError, string]> = [
      [new UnauthorizedError('Bad key', 'invalid_api_key'), 'invalid_request_error'],
      [new NotFoundError('No such model', 'model_not_found'), 'invalid_request_error'],
      [new ConflictError('Already running', 'in_flight'), 'invalid_request_error'],
      [new LockedError('Account locked', 'locked'), 'invalid_request_error'],
    ];
    for (const [err, expected] of cases) {
      expect(failure(err)).toEqual({
        error: { message: err.message, type: expected, code: err.code },
      });
    }
  });

  it('includes error.param only when the ApiError carries one', () => {
    expect(failure(new ValidationError('model is required', { param: 'model' }))).toEqual({
      error: {
        message: 'model is required',
        type: 'invalid_request_error',
        code: 'validation_failed',
        param: 'model',
      },
    });
    const out = failure(new ApiError('bad', { status: 400, code: 'bad_request' }));
    expect(out).toEqual({ error: { message: 'bad', type: 'invalid_request_error', code: 'bad_request' } });
    expect('param' in out.error).toBe(false);
  });
});

describe('OpenAI envelope success', () => {
  it('returns the raw model body by identity', () => {
    const body = { id: 'chatcmpl-1', object: 'chat.completion', choices: [] };
    expect(success(body)).toBe(body);
    expect(success('[DONE]')).toBe('[DONE]');
  });
});

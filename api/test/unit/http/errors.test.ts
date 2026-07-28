import { describe, it, expect } from 'vitest';
import * as errors from '../../../src/http/errors.js';
import {
  ApiError,
  ConflictError,
  ForbiddenError,
  LockedError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from '../../../src/http/errors.js';
import { failure as openaiFailure } from '../../../src/http/envelope/openai.js';
import { failure as anthropicFailure } from '../../../src/http/envelope/anthropic.js';

/**
 * Every route's error body is derived from these fields, so the status/code/
 * type each subclass declares is a wire contract, not an implementation
 * detail. Several of the declared types (`conflict_error`, `locked_error`,
 * `service_unavailable`, and the base `api_error`) are documented by neither
 * wire family, so what a client actually sees depends on each envelope's
 * status fallback — the cross-family block below pins that end to end.
 */

type ApiErrorSubclass = new (message: string) => ApiError;

/**
 * Reflect over the module's exports instead of listing the classes by hand, so
 * a subclass added later is dragged through the wire-format assertions without
 * anyone remembering to register it here.
 */
function discoverSubclasses(): Array<[string, ApiErrorSubclass]> {
  const found: Array<[string, ApiErrorSubclass]> = [];
  for (const [name, value] of Object.entries(errors) as Array<[string, unknown]>) {
    if (typeof value === 'function' && value.prototype instanceof ApiError) {
      found.push([name, value as ApiErrorSubclass]);
    }
  }
  return found;
}

const SUBCLASSES = discoverSubclasses();

/** The status/code/type each default-constructed subclass declares. */
const DECLARED: Array<[string, ApiError, number, string, string]> = [
  ['ValidationError', new ValidationError('Invalid'), 422, 'validation_failed', 'invalid_request_error'],
  ['UnauthorizedError', new UnauthorizedError(), 401, 'unauthorized', 'authentication_error'],
  ['ForbiddenError', new ForbiddenError(), 403, 'forbidden', 'permission_error'],
  ['NotFoundError', new NotFoundError(), 404, 'not_found', 'not_found_error'],
  ['ConflictError', new ConflictError(), 409, 'conflict', 'conflict_error'],
  ['RateLimitedError', new RateLimitedError(), 429, 'rate_limited', 'rate_limit_error'],
  ['LockedError', new LockedError(), 423, 'locked', 'locked_error'],
  ['ServiceUnavailableError', new ServiceUnavailableError(), 503, 'unavailable', 'service_unavailable'],
];

describe('ApiError base defaults', () => {
  it('falls back to 400/error/api_error with no param, extra or headers', () => {
    const err = new ApiError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
    expect(err.name).toBe('ApiError');
    expect(err.status).toBe(400);
    expect(err.code).toBe('error');
    expect(err.type).toBe('api_error');
    expect(err.param).toBeUndefined();
    expect(err.extra).toBeUndefined();
    expect(err.headers).toBeUndefined();
  });

  it('takes every field from the options bag when given one', () => {
    const err = new ApiError('boom', {
      status: 418,
      code: 'teapot',
      type: 'server_error',
      param: 'kettle',
      extra: { brew: 'no' },
      headers: { 'Retry-After': '3' },
    });
    expect(err.status).toBe(418);
    expect(err.code).toBe('teapot');
    expect(err.type).toBe('server_error');
    expect(err.param).toBe('kettle');
    expect(err.extra).toEqual({ brew: 'no' });
    expect(err.headers).toEqual({ 'Retry-After': '3' });
  });
});

describe('ApiError subclass declarations', () => {
  it('sets the documented status, code and type', () => {
    for (const [name, err, status, code, type] of DECLARED) {
      expect(err.name, name).toBe(name);
      expect(err.status, name).toBe(status);
      expect(err.code, name).toBe(code);
      expect(err.type, name).toBe(type);
    }
  });

  it('defaults its message and accepts a caller-supplied code', () => {
    expect(new UnauthorizedError().message).toBe('Unauthorized');
    expect(new ForbiddenError().message).toBe('Forbidden');
    expect(new NotFoundError().message).toBe('Not found');
    expect(new ConflictError().message).toBe('Conflict');
    expect(new RateLimitedError().message).toBe('Rate limited');
    expect(new LockedError().message).toBe('Locked');
    expect(new ServiceUnavailableError().message).toBe('Service unavailable');

    expect(new UnauthorizedError('Bad key', 'invalid_api_key').code).toBe('invalid_api_key');
    expect(new ForbiddenError('Nope', 'scope_missing').code).toBe('scope_missing');
    expect(new NotFoundError('No model', 'model_not_found').code).toBe('model_not_found');
    expect(new ConflictError('Running', 'in_flight').code).toBe('in_flight');
    expect(new LockedError('Locked out', 'account_locked').code).toBe('account_locked');
    expect(new ServiceUnavailableError('Draining', 'draining').code).toBe('draining');
  });

  it('carries ValidationError param and extra', () => {
    const err = new ValidationError('model is required', { param: 'model', extra: { hint: 'set it' } });
    expect(err.param).toBe('model');
    expect(err.extra).toEqual({ hint: 'set it' });
    expect(new ValidationError('bad').param).toBeUndefined();
    expect(new ValidationError('bad').extra).toBeUndefined();
  });

  it('carries ConflictError extra', () => {
    const err = new ConflictError('Already running', 'in_flight', { job_id: 'j1' });
    expect(err.extra).toEqual({ job_id: 'j1' });
    expect(new ConflictError().extra).toBeUndefined();
  });

  it('carries RateLimitedError bucket/reset_at extra and a conditional Retry-After header', () => {
    const err = new RateLimitedError('Slow down', {
      bucket: 'per_minute',
      resetAt: '2026-07-29T00:00:00Z',
      retryAfter: 30,
    });
    expect(err.extra).toEqual({ bucket: 'per_minute', reset_at: '2026-07-29T00:00:00Z' });
    expect(err.headers).toEqual({ 'Retry-After': '30' });

    // The extra keys exist even unset; the header only appears for a truthy
    // retryAfter, so 0 seconds emits no header at all.
    expect(new RateLimitedError().extra).toStrictEqual({ bucket: undefined, reset_at: undefined });
    expect(new RateLimitedError().headers).toBeUndefined();
    expect(new RateLimitedError('Slow down', { retryAfter: 0 }).headers).toBeUndefined();
  });
});

describe('ApiError toJSON', () => {
  it('emits message, code and type, omitting param when unset', () => {
    expect(new ApiError('boom').toJSON()).toEqual({ message: 'boom', code: 'error', type: 'api_error' });
    expect('param' in new ApiError('boom').toJSON()).toBe(false);
    expect(new ValidationError('model is required', { param: 'model' }).toJSON()).toEqual({
      message: 'model is required',
      code: 'validation_failed',
      type: 'invalid_request_error',
      param: 'model',
    });
  });

  it('spreads extra onto the body', () => {
    expect(new ConflictError('Already running', 'in_flight', { job_id: 'j1' }).toJSON()).toEqual({
      message: 'Already running',
      code: 'in_flight',
      type: 'conflict_error',
      job_id: 'j1',
    });
    expect(
      new RateLimitedError('Slow down', { bucket: 'per_minute', resetAt: '2026-07-29T00:00:00Z' }).toJSON(),
    ).toEqual({
      message: 'Slow down',
      code: 'rate_limited',
      type: 'rate_limit_error',
      bucket: 'per_minute',
      reset_at: '2026-07-29T00:00:00Z',
    });
  });

  it('never emits headers, which the envelope sets on the reply instead', () => {
    const rateLimited = new RateLimitedError('Slow down', { retryAfter: 30 }).toJSON();
    expect('headers' in rateLimited).toBe(false);
    expect('Retry-After' in rateLimited).toBe(false);
    for (const [name, Cls] of SUBCLASSES) {
      expect('headers' in new Cls(`${name} boom`).toJSON(), name).toBe(false);
    }
  });
});

describe('exported subclass discovery', () => {
  it('finds the exported subclasses without a hand-written list', () => {
    const names = SUBCLASSES.map(([name]) => name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual(
      expect.arrayContaining(['ValidationError', 'ConflictError', 'LockedError', 'ServiceUnavailableError']),
    );
    // ApiError is the base, not a subclass of itself.
    expect(names).not.toContain('ApiError');
  });

  it('has a declared status/code/type assertion for every discovered subclass', () => {
    expect(SUBCLASSES.map(([name]) => name).sort()).toEqual(DECLARED.map(([name]) => name).sort());
  });
});

/**
 * The `error.type` values each family documents. A subclass type outside its
 * family's set must be remapped by that envelope's status fallback before it
 * reaches a client, so every subclass — including the ones no family documents
 * — has to land inside these sets.
 */
const OPENAI_DOCUMENTED_TYPES = new Set([
  'invalid_request_error',
  'rate_limit_error',
  'insufficient_quota',
  'server_error',
]);

const ANTHROPIC_DOCUMENTED_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'overloaded_error',
]);

describe('every subclass maps to a documented type in both wire families', () => {
  it('narrows error.type to the OpenAI documented set and keeps err.code', () => {
    for (const [name, Cls] of SUBCLASSES) {
      const err = new Cls(`${name} boom`);
      const out = openaiFailure(err);
      expect(OPENAI_DOCUMENTED_TYPES.has(out.error.type), `${name} -> ${out.error.type}`).toBe(true);
      expect(out.error.code, name).toBe(err.code);
      expect(out.error.message, name).toBe(err.message);
    }
  });

  it('narrows error.type to the Anthropic documented set and keeps err.code', () => {
    for (const [name, Cls] of SUBCLASSES) {
      const err = new Cls(`${name} boom`);
      const out = anthropicFailure(err);
      expect(ANTHROPIC_DOCUMENTED_TYPES.has(out.error.type), `${name} -> ${out.error.type}`).toBe(true);
      expect(out.error.code, name).toBe(err.code);
      expect(out.error.message, name).toBe(err.message);
    }
  });

  it('maps the base ApiError default type in both families', () => {
    const err = new ApiError('boom');
    // `api_error` is undocumented for OpenAI (remapped off the 400) but is a
    // documented Anthropic type, so it passes through there untouched.
    expect(openaiFailure(err).error.type).toBe('invalid_request_error');
    expect(anthropicFailure(err).error.type).toBe('api_error');
    expect(openaiFailure(err).error.code).toBe('error');
    expect(anthropicFailure(err).error.code).toBe('error');
  });
});

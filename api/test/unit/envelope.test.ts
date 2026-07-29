import { describe, it, expect } from 'vitest';
import { selectFormatter } from '../../src/http/envelope/select.js';
import { ApiError } from '../../src/http/errors.js';

describe('envelope selection', () => {
  it('routes /v1/* to OpenAI formatter', () => {
    const f = selectFormatter('/v1/chat/completions');
    expect(f.kind).toBe('openai');
    const wrapped = f.failure(new ApiError('boom', { status: 400, code: 'bad', type: 'invalid_request_error' }));
    expect(wrapped).toMatchObject({ error: { type: 'invalid_request_error', code: 'bad', message: 'boom' } });
    expect(f.success({ id: 'chatcmpl-1' })).toEqual({ id: 'chatcmpl-1' });
  });

  it('routes /anthropic/v1/* to Anthropic formatter', () => {
    const f = selectFormatter('/anthropic/v1/messages');
    expect(f.kind).toBe('anthropic');
    const e = f.failure(new ApiError('nope', { status: 401, type: 'authentication_error', code: 'invalid_api_key' }));
    expect(e).toMatchObject({ type: 'error', error: { type: 'authentication_error', message: 'nope' } });
  });

  it('constrains Anthropic error.type to the documented set', () => {
    const f = selectFormatter('/anthropic/v1/messages');
    // Documented types pass through untouched.
    for (const type of [
      'invalid_request_error',
      'authentication_error',
      'permission_error',
      'not_found_error',
      'request_too_large',
      'rate_limit_error',
      'api_error',
      'overloaded_error',
    ]) {
      const e = f.failure(new ApiError('x', { status: 400, type, code: 'c' }));
      expect(e).toMatchObject({ error: { type } });
    }
    // Anything else falls back to the type matching the HTTP status. These
    // come from the shared error classes (ServiceUnavailableError, ConflictError,
    // LockedError), which are reachable from any route this envelope serves.
    const cases: Array<[string, number, string]> = [
      ['service_unavailable', 503, 'api_error'],
      ['locked_error', 423, 'invalid_request_error'],
      ['conflict_error', 409, 'invalid_request_error'],
      ['whatever', 401, 'authentication_error'],
      ['whatever', 403, 'permission_error'],
      ['whatever', 404, 'not_found_error'],
      ['whatever', 413, 'request_too_large'],
      ['whatever', 429, 'rate_limit_error'],
      ['whatever', 529, 'overloaded_error'],
      ['whatever', 502, 'api_error'],
    ];
    for (const [type, status, expected] of cases) {
      const e = f.failure(new ApiError('x', { status, type, code: 'c' }));
      expect(e).toMatchObject({ type: 'error', error: { type: expected, message: 'x' } });
    }
  });

  it('routes everything else to the standard envelope', () => {
    const f = selectFormatter('/admin/overview');
    expect(f.kind).toBe('standard');
    expect(f.success({ a: 1 })).toMatchObject({ status: 'ok', a: 1 });
    expect(f.failure(new ApiError('bad', { status: 400, code: 'bad' }))).toMatchObject({
      status: 'error',
      message: 'bad',
      code: 'bad',
    });
  });

  it('only ever selects one of the three envelope families', () => {
    // Handlers that need an unshaped body set reply.envelopeRaw, which skips the
    // onSend hook entirely -- there is no fourth formatter to select.
    for (const url of ['/anthropic/v1/messages', '/v1/chat/completions', '/admin/overview']) {
      expect(['standard', 'openai', 'anthropic']).toContain(selectFormatter(url).kind);
    }
  });
});

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
});

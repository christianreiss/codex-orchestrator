import { describe, it, expect } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { ApiError } from '../../src/http/errors.js';

describe('envelope plugin integration', () => {
  it('wraps standard handler payload as { status: ok, ... }', async () => {
    const app = await buildTestApp();
    app.get('/echo', async () => ({ hello: 'world' }));
    const r = await app.inject({ method: 'GET', url: '/echo' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ status: 'ok', hello: 'world' });
    await app.close();
  });

  it('shapes OpenAI errors via /v1/* formatter', async () => {
    const app = await buildTestApp();
    app.post('/v1/chat/completions', async () => {
      throw new ApiError('invalid model', {
        status: 400,
        code: 'model_not_found',
        type: 'invalid_request_error',
        param: 'model',
      });
    });
    const r = await app.inject({ method: 'POST', url: '/v1/chat/completions' });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toEqual({
      error: {
        message: 'invalid model',
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: 'model',
      },
    });
    await app.close();
  });

  it('shapes Anthropic errors via /anthropic/v1/* formatter', async () => {
    const app = await buildTestApp();
    app.post('/anthropic/v1/messages', async () => {
      throw new ApiError('auth failed', {
        status: 401,
        code: 'invalid_api_key',
        type: 'authentication_error',
      });
    });
    const r = await app.inject({ method: 'POST', url: '/anthropic/v1/messages' });
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.payload)).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'auth failed', code: 'invalid_api_key' },
    });
    await app.close();
  });

  it('passes raw bodies (binary, sse) through unchanged when envelopeRaw is set', async () => {
    const app = await buildTestApp();
    app.get('/binary', async (_req, reply) => {
      reply.envelopeRaw = true;
      reply.header('content-type', 'application/octet-stream');
      return Buffer.from([1, 2, 3]);
    });
    const r = await app.inject({ method: 'GET', url: '/binary' });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    await app.close();
  });

  it('returns standard not-found envelope for unmatched routes', async () => {
    const app = await buildTestApp();
    const r = await app.inject({ method: 'GET', url: '/does/not/exist' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'error', code: 'not_found' });
    await app.close();
  });
});

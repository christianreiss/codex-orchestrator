import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse, type RouteHandlerMethod } from 'fastify';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { ApiError } from '../../../src/http/errors.js';
import { ok } from '../../../src/http/reply.js';

/**
 * `envelopePlugin` is the single funnel every response and every error passes
 * through. The formatters themselves are pinned by envelope.test.ts and
 * envelope-standard.test.ts; what is pinned here is the plugin's own wiring:
 *
 *   - the onSend passthrough gates — rewriting an SSE, binary or text body
 *     corrupts it, and re-enveloping an already-rendered error body would
 *     double-wrap it;
 *   - the `toApiError` ladder that translates Fastify's *own* errors (schema
 *     validation, unsupported media type, and anything else carrying a
 *     `statusCode`) into a code/type pair. A wrong pair there is a
 *     client-visible wire-format break on `/v1/*` and `/anthropic/v1/*` that no
 *     route-level suite sees, because no route throws these errors — Fastify
 *     does.
 */

/** One URL per envelope the plugin can select. */
const PREFIXES = ['/admin', '/v1', '/anthropic/v1'] as const;

async function buildProbe(routes: (app: FastifyInstance, prefix: string) => void): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(envelopePlugin);
  for (const prefix of PREFIXES) routes(app, prefix);
  await app.ready();
  return app;
}

/**
 * The shape Fastify's `createError` produces: an Error carrying a numeric
 * `statusCode` and (usually) a string `code`. That pair is all `toApiError`
 * branches on, so a hand-built one exercises the same ladder as a real
 * `FST_ERR_*` — the two cases below that Fastify can be provoked into
 * generating for itself use the genuine article.
 */
function fastifyStyleError(statusCode: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

describe('envelope onSend passthroughs', () => {
  /**
   * All probed under `/admin`, the only prefix whose formatter would visibly
   * change the body: on `/v1/*` and `/anthropic/v1/*` success shaping is the
   * identity, so a passthrough there proves nothing.
   */
  const CASES: Array<{
    label: string;
    path: string;
    handler: RouteHandlerMethod;
    status: number;
    contentType: string;
    body: string;
  }> = [
    {
      label: 'reply.envelopeRaw = true opts the handler out entirely',
      path: 'raw',
      handler: async (_request, reply) => {
        reply.envelopeRaw = true;
        return { id: 'evt_1' };
      },
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: '{"id":"evt_1"}',
    },
    {
      label: 'a non-JSON content type is left alone',
      path: 'script',
      handler: async (_request, reply) => reply.type('text/plain').send('#!/bin/sh\necho hi\n'),
      status: 200,
      contentType: 'text/plain',
      body: '#!/bin/sh\necho hi\n',
    },
    {
      label: 'a Buffer body is left alone even under a JSON content type',
      path: 'buffer',
      // The JSON content type is deliberate: it gets past the content-type
      // gate, so only the Buffer check keeps this body from being re-shaped.
      handler: async (_request, reply) =>
        reply.type('application/json').send(Buffer.from('{"already":"shaped"}')),
      status: 200,
      contentType: 'application/json',
      body: '{"already":"shaped"}',
    },
    {
      label: 'a >= 400 body is left to the error handler',
      path: 'conflict',
      handler: async (_request, reply) => reply.code(409).send({ status: 'error', message: 'taken' }),
      status: 409,
      contentType: 'application/json; charset=utf-8',
      body: '{"status":"error","message":"taken"}',
    },
    {
      label: 'a string that is not JSON is left alone',
      path: 'unparseable',
      handler: async (_request, reply) => reply.type('application/json').send('<!doctype html>'),
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: '<!doctype html>',
    },
  ];

  it('returns every passthrough body byte-identical', async () => {
    const app = await buildProbe((instance, prefix) => {
      for (const c of CASES) instance.get(`${prefix}/${c.path}`, c.handler);
    });

    for (const c of CASES) {
      const res = await app.inject({ method: 'GET', url: `/admin/${c.path}` });
      expect(res.statusCode, c.label).toBe(c.status);
      expect(res.headers['content-type'], c.label).toBe(c.contentType);
      expect(res.rawPayload.equals(Buffer.from(c.body)), c.label).toBe(true);
    }

    await app.close();
  });
});

describe('envelope onSend ok() shaping', () => {
  const SHAPED: Record<string, unknown> = {
    // The standard envelope keeps object fields at the root *and* under `data`.
    '/admin': { status: 'ok', data: { hello: 'world' }, hello: 'world' },
    '/v1': { hello: 'world' },
    '/anthropic/v1': { hello: 'world' },
  };

  it('unwraps ok(data), shapes it per URL and rewrites content-length', async () => {
    const app = await buildProbe((instance, prefix) => {
      instance.get(`${prefix}/thing`, async () => ok({ hello: 'world' }));
    });

    for (const prefix of PREFIXES) {
      const res = await app.inject({ method: 'GET', url: `${prefix}/thing` });
      expect(res.statusCode, prefix).toBe(200);
      // The `ok` wrapper never reaches the wire.
      expect(JSON.parse(res.body), prefix).toEqual(SHAPED[prefix]);
      expect(res.headers['content-type'], prefix).toBe('application/json; charset=utf-8');
      // The handler's own payload was a different length; a stale
      // content-length truncates the body for a real client.
      expect(Number(res.headers['content-length']), prefix).toBe(res.rawPayload.length);
    }

    await app.close();
  });
});

describe('envelope error handler', () => {
  it('renders a thrown ApiError with its headers and status per envelope', async () => {
    const thrown = new ApiError('Rate limited', {
      status: 429,
      code: 'rate_limited',
      type: 'rate_limit_error',
      headers: { 'Retry-After': '30', 'X-RateLimit-Bucket': 'chat' },
    });
    const app = await buildProbe((instance, prefix) => {
      instance.get(`${prefix}/boom`, async () => {
        throw thrown;
      });
    });

    const expected: Record<string, unknown> = {
      '/admin': { status: 'error', message: 'Rate limited', code: 'rate_limited' },
      '/v1': { error: { message: 'Rate limited', type: 'rate_limit_error', code: 'rate_limited' } },
      '/anthropic/v1': {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Rate limited', code: 'rate_limited' },
      },
    };

    for (const prefix of PREFIXES) {
      const res = await app.inject({ method: 'GET', url: `${prefix}/boom` });
      expect(res.statusCode, prefix).toBe(429);
      expect(res.headers['retry-after'], prefix).toBe('30');
      expect(res.headers['x-ratelimit-bucket'], prefix).toBe('chat');
      expect(res.headers['content-type'], prefix).toBe('application/json; charset=utf-8');
      expect(JSON.parse(res.body), prefix).toEqual(expected[prefix]);
    }

    await app.close();
  });

  it('maps a plain Error to a 500 server_error without leaking its message', async () => {
    const app = await buildProbe((instance, prefix) => {
      instance.get(`${prefix}/boom`, async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3306');
      });
    });

    const expected: Record<string, unknown> = {
      '/admin': { status: 'error', message: 'Internal server error', code: 'server_error' },
      '/v1': { error: { message: 'Internal server error', type: 'server_error', code: 'server_error' } },
      '/anthropic/v1': {
        type: 'error',
        error: { type: 'api_error', message: 'Internal server error', code: 'server_error' },
      },
    };

    for (const prefix of PREFIXES) {
      const res = await app.inject({ method: 'GET', url: `${prefix}/boom` });
      expect(res.statusCode, prefix).toBe(500);
      expect(res.body, prefix).not.toContain('ECONNREFUSED');
      expect(JSON.parse(res.body), prefix).toEqual(expected[prefix]);
    }

    await app.close();
  });
});

describe('envelope toApiError ladder for Fastify-native errors', () => {
  interface LadderCase {
    label: string;
    /** Request that provokes the error, relative to a prefix. */
    request: (prefix: string) => {
      method: 'GET' | 'POST';
      url: string;
      payload?: string;
      headers?: Record<string, string>;
    };
    status: number;
    /** `expect.stringContaining` where the exact wording is Fastify's, not ours. */
    message: unknown;
    code: string;
    /** `error.type` as rendered by each of the two upstream wire formats. */
    openaiType: string;
    anthropicType: string;
  }

  /** Throws a Fastify-shaped error built from the query string. */
  function thrown(
    prefix: string,
    status: number,
    message: string,
    code?: string,
  ): { method: 'GET'; url: string } {
    const query = new URLSearchParams({
      status: String(status),
      message,
      ...(code ? { code } : {}),
    });
    return { method: 'GET', url: `${prefix}/throw?${query.toString()}` };
  }

  const CASES: LadderCase[] = [
    {
      label: "400 from schema validation keeps Fastify's own code",
      request: (prefix) => ({
        method: 'POST',
        url: `${prefix}/validated`,
        payload: '{}',
        headers: { 'content-type': 'application/json' },
      }),
      status: 400,
      message: expect.stringContaining("must have required property 'model'"),
      code: 'FST_ERR_VALIDATION',
      openaiType: 'invalid_request_error',
      anthropicType: 'invalid_request_error',
    },
    {
      label: '400 without a code falls back to bad_request',
      request: (prefix) => thrown(prefix, 400, 'model is required'),
      status: 400,
      message: 'model is required',
      code: 'bad_request',
      openaiType: 'invalid_request_error',
      anthropicType: 'invalid_request_error',
    },
    {
      label: '401 becomes unauthorized / authentication_error',
      request: (prefix) => thrown(prefix, 401, 'Missing bearer token', 'FST_ERR_AUTH'),
      status: 401,
      message: 'Missing bearer token',
      code: 'unauthorized',
      // OpenAI does not use `authentication_error` as an error.type upstream.
      openaiType: 'invalid_request_error',
      anthropicType: 'authentication_error',
    },
    {
      label: '404 becomes not_found / not_found_error',
      request: (prefix) => thrown(prefix, 404, 'Route not found', 'FST_ERR_NOT_FOUND'),
      status: 404,
      message: 'Route not found',
      code: 'not_found',
      openaiType: 'invalid_request_error',
      anthropicType: 'not_found_error',
    },
    {
      label: '415 from the content-type parser becomes unsupported_media_type',
      request: (prefix) => ({
        method: 'POST',
        url: `${prefix}/validated`,
        payload: '<req/>',
        headers: { 'content-type': 'text/xml' },
      }),
      status: 415,
      message: expect.stringContaining('Unsupported Media Type'),
      code: 'unsupported_media_type',
      openaiType: 'invalid_request_error',
      anthropicType: 'invalid_request_error',
    },
    {
      label: '500 masks the original message and defaults the code',
      request: (prefix) => thrown(prefix, 500, 'ER_ACCESS_DENIED_ERROR for user root@db'),
      status: 500,
      message: 'Internal server error',
      code: 'server_error',
      openaiType: 'server_error',
      anthropicType: 'api_error',
    },
    {
      label: '500 masks the message but keeps a code Fastify supplied',
      request: (prefix) => thrown(prefix, 500, 'stack trace here', 'FST_ERR_CTP_BODY_TOO_LARGE'),
      status: 500,
      message: 'Internal server error',
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
      openaiType: 'server_error',
      anthropicType: 'api_error',
    },
    {
      label: 'an unlisted status falls through with the message and no code/type',
      // 403 hits no rung of the ladder, so `code` and `type` stay at the
      // ApiError defaults — the message, unlike a 5xx, is preserved.
      request: (prefix) => thrown(prefix, 403, 'Host is not enrolled', 'FST_ERR_FORBIDDEN'),
      status: 403,
      message: 'Host is not enrolled',
      code: 'error',
      openaiType: 'invalid_request_error',
      anthropicType: 'api_error',
    },
  ];

  function expectedBody(prefix: string, c: LadderCase): unknown {
    if (prefix === '/v1') {
      return { error: { message: c.message, type: c.openaiType, code: c.code } };
    }
    if (prefix === '/anthropic/v1') {
      return { type: 'error', error: { type: c.anthropicType, message: c.message, code: c.code } };
    }
    // The standard envelope carries no `type`.
    return { status: 'error', message: c.message, code: c.code };
  }

  it('maps every rung to the declared code/type in all three envelopes', async () => {
    const app = await buildProbe((instance, prefix) => {
      instance.get(`${prefix}/throw`, async (request) => {
        const q = request.query as { status: string; message: string; code?: string };
        throw fastifyStyleError(Number(q.status), q.message, q.code);
      });
      instance.post(
        `${prefix}/validated`,
        {
          schema: {
            body: { type: 'object', required: ['model'], properties: { model: { type: 'string' } } },
          },
        },
        async () => ok({ accepted: true }),
      );
    });

    for (const c of CASES) {
      for (const prefix of PREFIXES) {
        const where = `${c.label} @ ${prefix}`;
        const res: LightMyRequestResponse = await app.inject(c.request(prefix));
        expect(res.statusCode, where).toBe(c.status);
        expect(res.headers['content-type'], where).toBe('application/json; charset=utf-8');
        expect(JSON.parse(res.body), where).toEqual(expectedBody(prefix, c));
      }
    }

    await app.close();
  });
});

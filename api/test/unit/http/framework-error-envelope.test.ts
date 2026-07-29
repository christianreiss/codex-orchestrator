import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { notFoundHandler } from '../../../src/http/not-found.js';

/**
 * Errors a client can provoke without any handler of ours ever running: a body
 * Fastify cannot parse, a content type it has no parser for, and an unmatched
 * path. Those bodies are rendered by `toApiError` + `selectFormatter` and by
 * `notFoundHandler`, never by a route, so no route-level suite sees them — yet
 * they are the first thing an OpenAI or Anthropic SDK meets when a request is
 * malformed, and a body outside the family's wire format breaks its error
 * classification just as hard as a wrong status would.
 *
 * The app below is the minimum that reproduces production dispatch: the
 * envelope plugin (error handler + onSend) and the shared not-found handler,
 * with one route under each of the three prefixes `selectFormatter` keys on.
 */

const PREFIXES = ['/v1', '/anthropic/v1', '/admin'] as const;
type Prefix = (typeof PREFIXES)[number];

interface WireCase {
  label: string;
  /** The request that provokes the error, relative to a prefix. */
  request: (prefix: Prefix) => {
    method: 'GET' | 'POST';
    url: string;
    payload?: string;
    headers?: Record<string, string>;
  };
  status: number;
  /** `expect.stringContaining` where the wording is Fastify's, not ours. */
  message: unknown;
  code: string;
  /** `error.type` as each upstream wire format renders it. */
  openaiType: string;
  anthropicType: string;
}

const CASES: WireCase[] = [
  {
    label: 'a body that is not valid JSON',
    request: (prefix) => ({
      method: 'POST',
      url: `${prefix}/echo`,
      // Truncated mid-object: the JSON parser rejects it before routing.
      payload: '{"model": "gpt-4"',
      headers: { 'content-type': 'application/json' },
    }),
    status: 400,
    message: expect.stringContaining('not valid JSON'),
    // 400 keeps whatever code Fastify supplied.
    code: 'FST_ERR_CTP_INVALID_JSON_BODY',
    openaiType: 'invalid_request_error',
    anthropicType: 'invalid_request_error',
  },
  {
    label: 'a content type with no parser',
    request: (prefix) => ({
      method: 'POST',
      url: `${prefix}/echo`,
      payload: '<request><model>gpt-4</model></request>',
      headers: { 'content-type': 'application/xml' },
    }),
    status: 415,
    message: expect.stringContaining('Unsupported Media Type'),
    code: 'unsupported_media_type',
    openaiType: 'invalid_request_error',
    anthropicType: 'invalid_request_error',
  },
  {
    label: 'a handler rejecting with a bare statusCode carrier',
    request: (prefix) => ({ method: 'GET', url: `${prefix}/boom` }),
    status: 500,
    // 5xx messages are masked; the original names an internal resource.
    message: 'Internal server error',
    code: 'server_error',
    openaiType: 'server_error',
    anthropicType: 'api_error',
  },
  {
    label: 'an unmatched path',
    request: (prefix) => ({ method: 'GET', url: `${prefix}/no-such-endpoint` }),
    status: 404,
    message: 'Route not found',
    code: 'not_found',
    // OpenAI never emits `not_found_error` as an error type upstream.
    openaiType: 'invalid_request_error',
    anthropicType: 'not_found_error',
  },
];

function expectedBody(prefix: Prefix, c: WireCase): unknown {
  if (prefix === '/v1') {
    return { error: { message: c.message, type: c.openaiType, code: c.code } };
  }
  if (prefix === '/anthropic/v1') {
    return { type: 'error', error: { type: c.anthropicType, message: c.message, code: c.code } };
  }
  // The standard envelope carries no `type`.
  return { status: 'error', message: c.message, code: c.code };
}

describe('framework-generated errors per wire family', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(envelopePlugin);
    app.setNotFoundHandler(notFoundHandler);
    for (const prefix of PREFIXES) {
      app.post(`${prefix}/echo`, async (request) => request.body);
      app.get(`${prefix}/boom`, async () => {
        // Not an Error instance: only the numeric `statusCode` drives the
        // mapping, which is all a rejected upstream call may carry.
        throw { statusCode: 500, message: 'pool exhausted at db-1.internal:3306' };
      });
    }
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('renders each error in the shape its prefix dictates', async () => {
    for (const c of CASES) {
      for (const prefix of PREFIXES) {
        const where = `${c.label} @ ${prefix}`;
        const res = await app.inject(c.request(prefix));
        expect(res.statusCode, where).toBe(c.status);
        expect(res.headers['content-type'], where).toBe('application/json; charset=utf-8');
        expect(JSON.parse(res.body), where).toEqual(expectedBody(prefix, c));
      }
    }
  });

  it('never leaks the internal 5xx message into any envelope', async () => {
    for (const prefix of PREFIXES) {
      const res = await app.inject({ method: 'GET', url: `${prefix}/boom` });
      expect(res.body, prefix).not.toContain('db-1.internal');
    }
  });
});

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { installGatewayBodyCapture } from '../../../src/http/gateway-dispatch.js';

/**
 * The gateway scope swaps Fastify's string JSON/text parsers for buffer
 * parsers that keep the exact bytes for the upstream forward. The emulated
 * routes must not notice: every body the root scope accepts or rejects is
 * accepted or rejected the same way, with the same status, error code and
 * parsed value, in the capture scope.
 */
const LIMIT = 256;

async function build(capture: boolean): Promise<{ app: FastifyInstance; raw: Array<Buffer | undefined> }> {
  const app = Fastify({ logger: false, bodyLimit: LIMIT });
  const raw: Array<Buffer | undefined> = [];
  const route = (scope: FastifyInstance) => {
    scope.post('/echo', async (req) => {
      raw.push(req.gatewayRawBody);
      return { body: req.body ?? null, type: typeof req.body };
    });
  };
  if (capture) {
    await app.register(async (scope) => {
      installGatewayBodyCapture(scope);
      route(scope);
    });
  } else {
    route(app);
  }
  await app.ready();
  return { app, raw };
}

const CASES: Array<{ name: string; status: number; contentType?: string; payload: string | Buffer }> = [
  { name: 'valid JSON', status: 200, contentType: 'application/json', payload: '{"model":"x","n":1}' },
  { name: 'JSON with charset', status: 200, contentType: 'application/json; charset=utf-8', payload: '{"a":"ü€"}' },
  { name: 'invalid JSON', status: 400, contentType: 'application/json', payload: '{"model":' },
  { name: 'empty JSON body', status: 400, contentType: 'application/json', payload: '' },
  { name: 'BOM-prefixed JSON', status: 200, contentType: 'application/json', payload: Buffer.from('﻿{"a":1}', 'utf8') },
  { name: '__proto__ poisoning', status: 400, contentType: 'application/json', payload: '{"__proto__":{"x":1}}' },
  { name: 'constructor poisoning', status: 400, contentType: 'application/json', payload: '{"constructor":{"prototype":{"x":1}}}' },
  { name: 'oversize JSON', status: 413, contentType: 'application/json', payload: JSON.stringify({ a: 'x'.repeat(LIMIT) }) },
  { name: 'split multi-byte UTF-8', status: 200, contentType: 'application/json', payload: Buffer.from('{"a":"' + '€'.repeat(40) + '"}', 'utf8') },
  { name: 'text/plain', status: 200, contentType: 'text/plain', payload: 'hello world' },
  { name: 'oversize text/plain', status: 413, contentType: 'text/plain', payload: 'y'.repeat(LIMIT + 1) },
  { name: 'unknown content type', status: 415, contentType: 'application/x-unknown', payload: 'abc' },
  { name: 'JSON suffix type', status: 415, contentType: 'application/vnd.api+json', payload: '{"a":1}' },
];

describe('installGatewayBodyCapture', () => {
  it.each(CASES)('treats $name like the root scope', async ({ status, contentType, payload }) => {
    const root = await build(false);
    const scoped = await build(true);
    try {
      const headers = contentType ? { 'content-type': contentType } : {};
      const a = await root.app.inject({ method: 'POST', url: '/echo', headers, payload });
      const b = await scoped.app.inject({ method: 'POST', url: '/echo', headers, payload });
      expect(a.statusCode).toBe(status);
      expect(b.statusCode).toBe(a.statusCode);
      expect(b.json()).toEqual(a.json());
      expect(b.headers['content-type']).toBe(a.headers['content-type']);
      expect(b.headers.connection).toBe(a.headers.connection);
      if (b.statusCode === 200) {
        const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
        expect(scoped.raw[0]?.equals(bytes)).toBe(true);
      }
    } finally {
      await root.app.close();
      await scoped.app.close();
    }
  });

  it('leaves bodyless requests and the parent scope untouched', async () => {
    const app = Fastify({ logger: false });
    let parentRaw: unknown = 'unset';
    let childRaw: unknown = 'unset';
    app.post('/parent', async (req) => {
      parentRaw = req.gatewayRawBody;
      return { ok: true };
    });
    await app.register(async (scope) => {
      installGatewayBodyCapture(scope);
      scope.post('/child', async (req) => {
        childRaw = req.gatewayRawBody;
        return { ok: true };
      });
    });
    await app.ready();
    try {
      await app.inject({ method: 'POST', url: '/parent', payload: { a: 1 } });
      expect(parentRaw).toBeUndefined();
      await app.inject({ method: 'POST', url: '/child' });
      expect(childRaw).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

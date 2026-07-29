import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';

/**
 * `req.id` is what every log line and error envelope is correlated by, so a
 * caller-supplied `X-Request-Id` is only honoured while it stays inside
 * `[A-Za-z0-9._-]{1,128}` — anything wider (a space, a newline, an unbounded
 * length) would let a client forge or wrap log records. Whatever we settle on
 * has to reach both `req.id` and the echoed response header.
 */

const GENERATED = /^[0-9a-f]{16}$/;

/**
 * `inject`, like Node, collapses a duplicated header into one comma-joined
 * string, so `splitRepeated` re-splits it into the array shape Fastify's header
 * type allows — from a hook registered ahead of the plugin, so the plugin still
 * sees it on the way in.
 */
async function buildProbe(opts: { splitRepeated?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  if (opts.splitRepeated) {
    app.addHook('onRequest', async (req) => {
      const raw = req.headers['x-request-id'];
      if (typeof raw === 'string') req.headers['x-request-id'] = raw.split(',');
    });
  }
  await app.register(requestIdPlugin);
  app.get('/probe', async (req) => ({ id: req.id }));
  await app.ready();
  return app;
}

/** The id the plugin settled on, asserted to be the same on `req.id` and the header. */
async function requestId(
  app: FastifyInstance,
  headers: Record<string, string | string[]> = {},
): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/probe', headers });
  expect(res.statusCode).toBe(200);
  const id = (res.json() as { id: string }).id;
  expect(res.headers['x-request-id']).toBe(id);
  return id;
}

describe('request-id plugin', () => {
  it('honours a well-formed caller-supplied header', async () => {
    const app = await buildProbe();
    expect(await requestId(app, { 'x-request-id': 'abc-123_XYZ.9' })).toBe('abc-123_XYZ.9');
    // The full in-class alphabet, and the 128-char upper bound, are still ours.
    expect(await requestId(app, { 'x-request-id': 'aZ0._-' })).toBe('aZ0._-');
    const maxLength = 'a'.repeat(128);
    expect(await requestId(app, { 'x-request-id': maxLength })).toBe(maxLength);
    await app.close();
  });

  it('takes the first value of a repeated header', async () => {
    const app = await buildProbe({ splitRepeated: true });
    expect(await requestId(app, { 'x-request-id': 'first-id,second-id' })).toBe('first-id');
    // A repeated header whose first value is malformed is not rescued by the rest.
    expect(await requestId(app, { 'x-request-id': 'bad id,good-id' })).toMatch(GENERATED);
    await app.close();
  });

  it('generates an id when the supplied header is out of class', async () => {
    const app = await buildProbe();
    for (const candidate of [
      '',
      'a'.repeat(129),
      'has space',
      'has\nnewline',
      'has\ttab',
      'has/slash',
      'has:colon',
      'has%25escape',
      'näme',
    ]) {
      expect(await requestId(app, { 'x-request-id': candidate })).toMatch(GENERATED);
    }
    await app.close();
  });

  it('generates a distinct id for each request when no header is supplied', async () => {
    const app = await buildProbe();
    const first = await requestId(app);
    const second = await requestId(app);
    expect(first).toMatch(GENERATED);
    expect(second).toMatch(GENERATED);
    expect(first).not.toBe(second);
    await app.close();
  });
});

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyReply } from 'fastify';
import { ok, raw, isOkResult } from '../../../src/http/reply.js';

/**
 * The three helpers every handler's return path goes through. `isOkResult` is
 * the sole gate the envelope plugin uses to decide whether a handler result is
 * a wrapper to unwrap or a body to send as-is, so its exact accept/reject set
 * decides whether a service object that happens to carry `ok: true` gets
 * silently unwrapped to its `data`.
 */

describe('ok', () => {
  it('wraps a payload as { ok: true, data }', () => {
    expect(ok({ id: 'j1' })).toEqual({ ok: true, data: { id: 'j1' } });
    expect(ok('text')).toEqual({ ok: true, data: 'text' });
    expect(ok(0)).toEqual({ ok: true, data: 0 });
    expect(ok([1, 2])).toEqual({ ok: true, data: [1, 2] });
    expect(ok(null)).toEqual({ ok: true, data: null });
  });

  it('keeps the data key present with no argument, so isOkResult still accepts it', () => {
    const result = ok();
    expect(result.ok).toBe(true);
    expect(result.data).toBeUndefined();
    // The key itself has to exist: isOkResult gates on `'data' in x`, so a
    // no-arg ok() that dropped the key would not be unwrapped.
    expect('data' in result).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['data', 'ok']);
    expect(isOkResult(result)).toBe(true);
  });

  it('passes the payload through by reference rather than copying it', () => {
    const payload = { nested: { n: 1 } };
    expect(ok(payload).data).toBe(payload);
  });
});

describe('raw', () => {
  it('returns the same reply with envelopeRaw set, so the call stays chainable', async () => {
    const app = Fastify({ logger: false });
    let sameObject = false;
    let flagged = false;

    app.get('/probe', async (_req, reply) => {
      const returned = raw(reply);
      sameObject = returned === reply;
      flagged = reply.envelopeRaw === true;
      // The chained spelling the MCP route uses: code/type/send off the
      // helper's return value.
      returned.code(202).type('text/plain').send('body');
    });

    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(sameObject).toBe(true);
    expect(flagged).toBe(true);
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('body');
    await app.close();
  });

  it('sets envelopeRaw on a reply that has never carried the flag', () => {
    const reply = {} as FastifyReply;
    expect(reply.envelopeRaw).toBeUndefined();
    expect(raw(reply)).toBe(reply);
    expect(reply.envelopeRaw).toBe(true);
  });
});

describe('isOkResult', () => {
  it('accepts an ok wrapper even when its data is undefined', () => {
    expect(isOkResult({ ok: true, data: undefined })).toBe(true);
    expect(isOkResult({ ok: true, data: null })).toBe(true);
    expect(isOkResult({ ok: true, data: 0 })).toBe(true);
    expect(isOkResult({ ok: true, data: false })).toBe(true);
    expect(isOkResult({ ok: true, data: { id: 'j1' } })).toBe(true);
  });

  it('rejects an ok: true object with no data key', () => {
    // A service object that merely reports success is a body, not a wrapper.
    expect(isOkResult({ ok: true })).toBe(false);
    expect(isOkResult({ ok: true, status: 'healthy' })).toBe(false);
  });

  it('rejects anything whose ok is not the boolean true', () => {
    expect(isOkResult({ ok: false, data: 1 })).toBe(false);
    expect(isOkResult({ ok: 'true', data: 1 })).toBe(false);
    expect(isOkResult({ ok: 1, data: 1 })).toBe(false);
    expect(isOkResult({ data: 1 })).toBe(false);
  });

  it('rejects arrays, null and non-objects', () => {
    expect(isOkResult([])).toBe(false);
    expect(isOkResult([{ ok: true, data: 1 }])).toBe(false);
    expect(isOkResult(null)).toBe(false);
    expect(isOkResult(undefined)).toBe(false);
    expect(isOkResult('ok')).toBe(false);
    expect(isOkResult(1)).toBe(false);
    expect(isOkResult(true)).toBe(false);
    expect(isOkResult(() => ({ ok: true, data: 1 }))).toBe(false);
  });
});

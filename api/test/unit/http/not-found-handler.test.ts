import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { notFoundHandler } from '../../../src/http/not-found.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { registerStaticAdminRoutes } from '../../../src/routes/admin/pages/static.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

/**
 * The 404 body is per-family: `selectFormatter` shapes it from the URL prefix,
 * so an unmatched /v1/* path must fail the way an OpenAI SDK expects and
 * /anthropic/v1/* the way an Anthropic SDK does. Pin whole bodies — the fields
 * are what the SDKs classify on, and the `type: 'not_found_error'` the handler
 * passes is exactly what a hand-copied duplicate previously dropped.
 */

const HTML_NAVIGATION = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

async function buildBareApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(envelopePlugin);
  app.setNotFoundHandler(notFoundHandler);
  await app.ready();
  return app;
}

describe('shared not-found handler', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildBareApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('fails an unmatched /v1 path in the OpenAI error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/no-such-endpoint' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    // OpenAI never emits `not_found_error` as an error type, so the formatter
    // remaps it onto the documented type for a 404.
    expect(JSON.parse(res.payload)).toEqual({
      error: {
        message: 'Route not found',
        type: 'invalid_request_error',
        code: 'not_found',
      },
    });
  });

  it('fails an unmatched /anthropic/v1 path in the Anthropic error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/anthropic/v1/no-such-endpoint' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(res.payload)).toEqual({
      type: 'error',
      error: {
        type: 'not_found_error',
        message: 'Route not found',
        code: 'not_found',
      },
    });
  });

  it('fails an unmatched JSON /admin path in the standard envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/no-such-endpoint',
      headers: { accept: 'application/json' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(res.payload)).toEqual({
      status: 'error',
      message: 'Route not found',
      code: 'not_found',
    });
  });
});

describe('static admin not-found handler', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'codex-not-found-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Codex Admin</title>');

    app = Fastify({ logger: false });
    const ctx: RouteContext = {
      db: {} as RouteContext['db'],
      env: { ...loadTestEnv(), STATIC_ROOT: root },
      keyring: testKeyring(),
    };
    await app.register(envelopePlugin);
    await registerStaticAdminRoutes(app, ctx);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the SPA index for an HTML navigation under /admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/no-such-page',
      headers: { accept: HTML_NAVIGATION },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.payload).toContain('Codex Admin');
  });

  it('falls through to the shared JSON body for a non-HTML request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/no-such-endpoint',
      headers: { accept: 'application/json' },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({
      status: 'error',
      message: 'Route not found',
      code: 'not_found',
    });
  });
});

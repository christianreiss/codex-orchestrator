import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { RouteContext } from '../../../src/routes/index.js';
import {
  assertPortalOrigin,
  registerAgentPortalPublicRoutes,
} from '../../../src/routes/agent-portal/public.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

function request(headers: Record<string, string> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function context(publicBaseUrl = 'https://portal.example'): RouteContext {
  return {
    env: { PUBLIC_BASE_URL: publicBaseUrl },
  } as unknown as RouteContext;
}

function expectCode(run: () => void, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('agent portal browser boundary', () => {
  it('registers one shell route under Fastify trailing-slash normalization', async () => {
    const app = Fastify({ logger: false, ignoreTrailingSlash: true });
    const ctx: RouteContext = {
      db: {} as RouteContext['db'],
      env: {
        ...loadTestEnv(),
        STATIC_ROOT: resolve(import.meta.dirname, '../../../../public/admin'),
      },
      keyring: testKeyring(),
    };

    await app.register(cookie);
    await registerAgentPortalPublicRoutes(app, ctx);
    await app.ready();

    try {
      for (const url of ['/go', '/go/']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
      }
    } finally {
      await app.close();
    }
  });

  it('accepts exact-origin mutations and same-origin reads', () => {
    expect(() => assertPortalOrigin(request({ origin: 'https://portal.example' }), context(), true)).not.toThrow();
    expect(() => assertPortalOrigin(request(), context(), false)).not.toThrow();
  });

  it('rejects missing mutation origins, foreign origins, and same-site browser requests', () => {
    expectCode(() => assertPortalOrigin(request(), context(), true), 'agent_portal_csrf');
    expectCode(
      () => assertPortalOrigin(request({ origin: 'https://evil.example' }), context(), false),
      'agent_portal_csrf',
    );
    expectCode(
      () => assertPortalOrigin(request({ 'sec-fetch-site': 'same-site' }), context(), false),
      'agent_portal_csrf',
    );
  });

  it('fails closed for browser-origin requests when PUBLIC_BASE_URL is unavailable', () => {
    expect(() => assertPortalOrigin(request(), context(''), false)).not.toThrow();
    expectCode(
      () => assertPortalOrigin(request({ origin: 'https://portal.example' }), context(''), false),
      'agent_portal_not_configured',
    );
    expectCode(() => assertPortalOrigin(request(), context(''), true), 'agent_portal_not_configured');
  });

  it('keeps every public API route behind the origin guard and reauthenticates SSE in-loop', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../../../src/routes/agent-portal/public.ts'),
      'utf8',
    );
    const routes = source.match(/app\.(?:get|post)\('\/go\/api\//g) ?? [];
    const guards = source.match(/assertPortalOrigin\(req, ctx, (?:true|false)\);/g) ?? [];
    expect(routes).toHaveLength(11);
    expect(guards).toHaveLength(routes.length);

    const stream = source.slice(
      source.indexOf("app.get('/go/api/events'"),
      source.indexOf('const portalRoot'),
    );
    // The invariant is that a page is re-authorized on every tick, never once
    // when the connection opened -- a stream outlives the check that started it,
    // and a revoked account must stop mid-flight. It used to be spelled as one
    // call inside the loop; since /go accepts a console session too, the two
    // identities re-authorize differently and the call sits behind `nextPage`.
    // What is asserted is still the property: the fetch happens inside the loop,
    // and each branch re-checks before it reads.
    expect(stream).toContain('const page = await nextPage(cursor);');
    expect(stream.indexOf('while (!closed')).toBeLessThan(
      stream.indexOf('const page = await nextPage(cursor);'),
    );

    const nextPage = stream.slice(
      stream.indexOf('const nextPage = async'),
      stream.indexOf('const query = z'),
    );
    // Portal branch: the service re-reads the browser session in its own
    // transaction, which is what makes revocation land mid-stream.
    expect(nextPage).toContain('portal.listEventsAfterAuthenticated(browserToken, from, 250)');
    // Admin branch: the unauthenticated reader is only ever reached after the
    // session and its capability have been resolved again on this same tick.
    expect(nextPage.indexOf("await actorFor(req, 'agent_portal.reveal_transcript')")).toBeLessThan(
      nextPage.indexOf('portal.listEventsAfter(from, 250)'),
    );
    expect(nextPage).toContain('portal.isEnabled()');
  });

  it('allows only safe engine events and derives their source on the server', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../../../src/routes/agent-portal/admin-host.ts'),
      'utf8',
    );
    const start = source.indexOf("app.post('/host/agent-sessions/:id/events'");
    const end = source.indexOf("app.post('/host/agent-sessions/:id/finish'", start);
    const route = source.slice(start, end);
    expect(route).toContain('z.enum(AGENT_BRIDGE_EVENT_TYPES)');
    expect(route).toContain("source: 'engine'");
    expect(route).toContain('.strict()');
    expect(route).not.toContain('source: body.source');
  });
});

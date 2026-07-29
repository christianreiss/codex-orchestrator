import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { RouteContext } from '../../../src/routes/index.js';
import { assertPortalOrigin } from '../../../src/routes/agent-portal/public.js';

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
    expect(routes).toHaveLength(9);
    expect(guards).toHaveLength(routes.length);

    const stream = source.slice(
      source.indexOf("app.get('/go/api/events'"),
      source.indexOf('const portalRoot'),
    );
    expect(stream).toContain('await portal.listEventsAfterAuthenticated(browserToken, cursor, 250);');
    expect(stream.indexOf('while (!closed')).toBeLessThan(
      stream.indexOf('await portal.listEventsAfterAuthenticated(browserToken, cursor, 250);'),
    );
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

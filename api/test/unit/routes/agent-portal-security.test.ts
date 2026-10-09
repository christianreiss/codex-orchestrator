import Fastify from 'fastify';
import { registerAgentPortalRoutes } from '../../../src/routes/agent-portal/index.js';
import { AgentPortalService } from '../../../src/services/agent-portal.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('agent session bridge boundary', () => {
  it('removes the browser and magic-link APIs while retaining host/admin session routes', async () => {
    const app = Fastify({ ignoreTrailingSlash: true });
    app.decorate('requireAdmin', async () => {});
    await registerAgentPortalRoutes(app, { db: {} as RouteContext['db'], env: loadTestEnv(), keyring: testKeyring() });
    const probe = vi.spyOn(AgentPortalService.prototype, 'state').mockResolvedValue({ enabled: true });
    try {
      for (const [method, url] of [
        ['GET', '/go'], ['GET', '/go/'], ['GET', '/go/u/old-link'],
        ['GET', '/go/api/agents'], ['GET', '/go/api/events'],
        ['POST', '/go/api/auth/exchange'], ['POST', '/go/api/daemon-sessions'],
        ['GET', '/admin/agent-portal/users'], ['POST', '/admin/agent-portal/users'],
        ['GET', '/admin/agent-portal/users/1/link'],
      ] as const) {
        const response = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined, headers: { cookie: 'agent_portal_session=retired-token' } });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
      expect((await app.inject('/admin/agent-portal/state')).statusCode).toBe(200);
      expect(app.hasRoute({ method: 'POST', url: '/host/agent-sessions' })).toBe(true);
      expect(app.hasRoute({ method: 'POST', url: '/host/agent-sessions/:id/commands/claim' })).toBe(true);
    } finally { probe.mockRestore(); await app.close(); }
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

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import {
  registerAdminSkillSourceRoutes,
  type MattPocockSkillSourceRouteService,
} from '../../../src/routes/admin/skill-sources/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import type { SkillSourceState } from '../../../src/services/mattpocock-skills.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';

const apps: Array<ReturnType<typeof Fastify>> = [];

function state(overrides: Partial<SkillSourceState> = {}): SkillSourceState {
  return {
    source: 'github:mattpocock/skills',
    repository: 'https://github.com/mattpocock/skills',
    ref: 'main',
    enabled: false,
    auto_update: true,
    status: 'disabled',
    revision: null,
    upstream_version: null,
    skill_count: 0,
    file_count: 0,
    last_checked_at: null,
    last_synced_at: null,
    last_error: null,
    ...overrides,
  };
}

async function buildApp(role: string | null, service: MattPocockSkillSourceRouteService) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  await registerCapabilityStack(app, { role });
  await registerAdminSkillSourceRoutes(
    app,
    { db: {} as never, env: {} as never, keyring: {} as never } as RouteContext,
    { mattPocock: service },
  );
  return app;
}

function serviceStub() {
  return {
    getState: vi.fn(async () => state()),
    configure: vi.fn(async (input: { enabled?: boolean; auto_update?: boolean }) => state(input)),
    refresh: vi.fn(async () => state({ enabled: true, status: 'ok', skill_count: 22 })),
  } satisfies MattPocockSkillSourceRouteService;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Matt Pocock skill source admin routes', () => {
  it('requires an admin session and permits a viewer to read state', async () => {
    const denied = await buildApp(null, serviceStub());
    expect((await denied.inject({ method: 'GET', url: '/admin/skill-sources/mattpocock' })).statusCode).toBe(401);

    const allowed = await buildApp('viewer', serviceStub());
    const response = await allowed.inject({ method: 'GET', url: '/admin/skill-sources/mattpocock' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ source: 'github:mattpocock/skills', enabled: false });
  });

  it('allows owner/admin mutations and passes strict boolean settings through', async () => {
    const service = serviceStub();
    const app = await buildApp('admin', service);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/skill-sources/mattpocock',
      payload: { enabled: true, auto_update: false },
    });
    expect(response.statusCode).toBe(200);
    expect(service.configure).toHaveBeenCalledWith({ enabled: true, auto_update: false });
  });

  it('rejects viewers, unknown settings, non-booleans, and refresh bodies', async () => {
    const viewerService = serviceStub();
    const viewer = await buildApp('viewer', viewerService);
    expect((await viewer.inject({
      method: 'POST',
      url: '/admin/skill-sources/mattpocock',
      payload: { enabled: true },
    })).statusCode).toBe(403);
    expect(viewerService.configure).not.toHaveBeenCalled();

    const service = serviceStub();
    const app = await buildApp('owner', service);
    for (const payload of [{}, { enabled: 1 }, { enabled: true, repository: 'elsewhere' }]) {
      const response = await app.inject({ method: 'POST', url: '/admin/skill-sources/mattpocock', payload });
      expect(response.statusCode).toBe(422);
    }
    const badRefresh = await app.inject({
      method: 'POST',
      url: '/admin/skill-sources/mattpocock/refresh',
      payload: { force: true },
    });
    expect(badRefresh.statusCode).toBe(422);
  });

  it('forces an authenticated manual refresh', async () => {
    const service = serviceStub();
    const app = await buildApp('owner', service);
    const response = await app.inject({ method: 'POST', url: '/admin/skill-sources/mattpocock/refresh' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', skill_count: 22 });
    expect(service.refresh).toHaveBeenCalledWith({ force: true });
  });
});

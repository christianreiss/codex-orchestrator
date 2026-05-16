import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildRouteApp } from '../../../helpers/build-route-app.js';
import { registerAdminJoplinRoutes } from '../../../../src/routes/admin/joplin/index.js';
import type { RouteContext } from '../../../../src/routes/index.js';
import {
  EMPTY_CONFIG,
  type JoplinConfig,
  fingerprint,
} from '../../../../src/services/joplin-config.js';

// Stub the joplin-config module so we can drive the route without a real DB.
// The mock keeps an in-memory record per test.
let memoryConfig: JoplinConfig;

vi.mock('../../../../src/services/joplin-config.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/services/joplin-config.js')>();
  return {
    ...real,
    readJoplinConfig: vi.fn(async () => ({ ...memoryConfig })),
    writeJoplinConfig: vi.fn(async (_db: unknown, _kr: unknown, c: JoplinConfig) => {
      memoryConfig = { ...c };
    }),
  };
});

// Stub the cache module so the sync test doesn't try to insert into a real DB.
vi.mock('../../../../src/services/joplin-cache.js', () => ({
  syncAllJoplinNotes: vi.fn(async () => ({
    synced_count: 3,
    deleted_count: 1,
    notebooks: 2,
    took_ms: 5,
  })),
}));

function makeCtx(): RouteContext {
  return {
    db: {} as RouteContext['db'],
    env: { STATIC_ROOT: '/tmp' } as RouteContext['env'],
    keyring: {} as RouteContext['keyring'],
  };
}

interface FakeClient {
  ping: () => Promise<{ reachable: boolean; reason: string | null; version: string | null }>;
}

function buildClient(reachable: boolean): FakeClient {
  return {
    async ping() {
      return reachable
        ? { reachable: true, reason: null, version: null }
        : { reachable: false, reason: 'down', version: null };
    },
  };
}

describe('admin/joplin routes', () => {
  beforeEach(() => {
    memoryConfig = { ...EMPTY_CONFIG };
  });

  it('GET /admin/joplin/config returns sanitised config state', async () => {
    const app = await buildRouteApp();
    await registerAdminJoplinRoutes(app, makeCtx());
    const r = await app.inject({ method: 'GET', url: '/admin/joplin/config' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as {
      status: string;
      enabled: boolean;
      activation_reason: string;
      password_hint: string;
    };
    expect(body.status).toBe('ok');
    expect(body.enabled).toBe(false);
    expect(body.password_hint).toBe('');
    expect(body.activation_reason).toBe('missing_url');
    await app.close();
  });

  it('POST /admin/joplin/config persists url/email/password and never leaks the password', async () => {
    const app = await buildRouteApp();
    await registerAdminJoplinRoutes(app, makeCtx());
    const r = await app.inject({
      method: 'POST',
      url: '/admin/joplin/config',
      payload: {
        url: 'https://joplin.example/',
        email: 'me@example.com',
        password: 'supersecrettoken',
        sync_interval_minutes: 30,
      },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as {
      url: string;
      password_set: boolean;
      password_hint: string;
      activation_reason: string;
    };
    // URL trimmed of trailing slash
    expect(body.url).toBe('https://joplin.example');
    expect(body.password_set).toBe(true);
    // Password never returned in plain
    expect(JSON.stringify(body)).not.toContain('supersecrettoken');
    expect(body.password_hint).toMatch(/^…/);
    expect(body.activation_reason).toBe('verification_required');
    await app.close();
  });

  it('POST /admin/joplin/config rejects non-http URLs', async () => {
    const app = await buildRouteApp();
    await registerAdminJoplinRoutes(app, makeCtx());
    const r = await app.inject({
      method: 'POST',
      url: '/admin/joplin/config',
      payload: { url: 'ftp://nope.example' },
    });
    expect(r.statusCode).toBe(422);
    await app.close();
  });

  it('POST /admin/joplin/test sets verified state when the probe succeeds', async () => {
    memoryConfig = {
      ...EMPTY_CONFIG,
      url: 'https://joplin.example',
      email: 'me@example.com',
      password: 'pw',
    };
    const app = await buildRouteApp();
    await registerAdminJoplinRoutes(app, makeCtx(), {
      buildClient: () => buildClient(true) as never,
    });
    const r = await app.inject({ method: 'POST', url: '/admin/joplin/test', payload: {} });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as {
      reachable: boolean;
      verified_connection: boolean;
      can_activate: boolean;
    };
    expect(body.reachable).toBe(true);
    expect(body.verified_connection).toBe(true);
    expect(body.can_activate).toBe(true);
    // Memory was updated with a fingerprint
    expect(memoryConfig.verifiedFingerprint).toBe(fingerprint(memoryConfig));
    await app.close();
  });

  it('POST /admin/joplin/test clears verification when the probe fails', async () => {
    memoryConfig = {
      ...EMPTY_CONFIG,
      url: 'https://joplin.example',
      email: 'me@example.com',
      password: 'pw',
      verifiedAt: '2026-01-01T00:00:00Z',
      verifiedFingerprint: 'stale',
    };
    const app = await buildRouteApp();
    await registerAdminJoplinRoutes(app, makeCtx(), {
      buildClient: () => buildClient(false) as never,
    });
    const r = await app.inject({ method: 'POST', url: '/admin/joplin/test', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(memoryConfig.verifiedFingerprint).toBeNull();
    expect(memoryConfig.verifiedAt).toBeNull();
    await app.close();
  });

  it('POST /admin/joplin/test rejects when credentials are missing', async () => {
    const app = await buildRouteApp();
    await registerAdminJoplinRoutes(app, makeCtx(), {
      buildClient: () => buildClient(true) as never,
    });
    const r = await app.inject({ method: 'POST', url: '/admin/joplin/test', payload: {} });
    expect(r.statusCode).toBe(422);
    await app.close();
  });

  it('POST /admin/joplin/sync requires a verified connection', async () => {
    memoryConfig = {
      ...EMPTY_CONFIG,
      url: 'https://joplin.example',
      email: 'me@example.com',
      password: 'pw',
    };
    const app = await buildRouteApp();
    await registerAdminJoplinRoutes(app, makeCtx(), {
      buildClient: () => buildClient(true) as never,
    });
    const r = await app.inject({ method: 'POST', url: '/admin/joplin/sync' });
    expect(r.statusCode).toBe(422);
    await app.close();
  });

  it('POST /admin/joplin/sync runs the syncer, publishes joplin.synced, and returns the result', async () => {
    memoryConfig = {
      ...EMPTY_CONFIG,
      url: 'https://joplin.example',
      email: 'me@example.com',
      password: 'pw',
    };
    memoryConfig.verifiedAt = '2026-01-01T00:00:00Z';
    memoryConfig.verifiedFingerprint = fingerprint(memoryConfig);

    const { wsPublisher } = await import('../../../../src/ws/publisher.js');
    const events: Array<{ type: string; payload: unknown }> = [];
    const unsub = wsPublisher.subscribe((ev) => events.push({ type: String(ev.type), payload: ev.payload }));

    try {
      const app = await buildRouteApp();
      await registerAdminJoplinRoutes(app, makeCtx(), {
        buildClient: () => buildClient(true) as never,
      });
      const r = await app.inject({ method: 'POST', url: '/admin/joplin/sync' });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload) as { sync: { synced_count: number; deleted_count: number } };
      expect(body.sync.synced_count).toBe(3);
      expect(body.sync.deleted_count).toBe(1);
      const synced = events.find((e) => e.type === 'joplin.synced');
      expect(synced).toBeDefined();
      await app.close();
    } finally {
      unsub();
    }
  });
});

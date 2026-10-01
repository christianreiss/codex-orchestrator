import { afterEach, describe, expect, it, vi } from 'vitest';
import { versions } from '../../../src/db/schema.js';
import { registerAdminSettingsRoutes } from '../../../src/routes/admin/settings/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';

afterEach(() => vi.restoreAllMocks());

async function buildApp() {
  const app = await buildRouteApp();
  const db = createDbFake();
  await registerAdminSettingsRoutes(app, {
    db: db as never,
    env: {} as never,
    keyring: {} as never,
  } as RouteContext);
  return { app, db };
}

describe('Grok admin version controls', () => {
  it('reports the native baseline without creating a global lock', async () => {
    const { app, db } = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/admin/grok/version' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      client_version: '1.0.46',
      client_version_lock: null,
      client_version_enforce_exact: false,
    });
    expect((db.tables.get(versions) ?? []).some((row) => row.name === 'client_version_lock_grok')).toBe(
      false,
    );
    expect((await app.inject({ method: 'GET', url: '/admin/grok/version/lock' })).json()).toMatchObject({
      locked_version: null,
      locked_at: null,
    });
    await app.close();
  });
  it('pins only Grok and rejects unsupported older native releases', async () => {
    const { app, db } = await buildApp();
    db.tables.set(versions, [
      { name: 'client_version_lock', version: '0.137.0' },
      { name: 'client_version_lock_claude', version: '2.1.170' },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/grok/version',
      payload: { selection: '1.0.47' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ locked_version: '1.0.47' });
    expect((await app.inject({ method: 'GET', url: '/admin/grok/version/lock' })).json()).toMatchObject({
      locked_version: '1.0.47',
    });
    expect(
      (await app.inject({ method: 'POST', url: '/admin/grok/version', payload: { selection: '1.0.45' } }))
        .statusCode,
    ).toBe(422);
    const rows = db.tables.get(versions) ?? [];
    expect(rows.find((row) => row.name === 'client_version_lock')?.version).toBe('0.137.0');
    expect(rows.find((row) => row.name === 'client_version_lock_claude')?.version).toBe('2.1.170');
    expect(rows.find((row) => row.name === 'client_version_lock_grok')?.version).toBe('1.0.47');
    await app.close();
  });
  it('refreshes all three release sources and returns engine-specific summaries', async () => {
    const { app } = await buildApp();
    const upstream = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async (url) =>
          ({
            ok: true,
            json: async () =>
              String(url).includes('xai-official')
                ? { version: '1.0.46' }
                : String(url).includes('anthropic-ai')
                  ? { version: '2.1.170' }
                  : { tag_name: 'rust-v0.137.0' },
          }) as Response,
      );
    const response = await app.inject({ method: 'POST', url: '/admin/versions/check', payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      available_client: { name: 'codex-cli', version: '0.137.0' },
      claude_available_client: { name: 'claude-cli', version: '2.1.170' },
      grok_available_client: { name: 'grok-cli', version: '1.0.46' },
      grok_versions: { client_version: '1.0.46', client_version_lock: null },
    });
    expect(upstream).toHaveBeenCalledTimes(3);
    await app.close();
  });
});

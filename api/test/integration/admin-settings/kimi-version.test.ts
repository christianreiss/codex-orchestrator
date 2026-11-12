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

describe('Kimi admin version controls', () => {
  it('follows latest by default without creating a global lock', async () => {
    const { app, db } = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/admin/kimi/version' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      client_version: 'latest',
      client_version_lock: null,
      client_version_enforce_exact: false,
    });
    expect((db.tables.get(versions) ?? []).some((row) => row.name === 'client_version_lock_kimi')).toBe(
      false,
    );
    expect((await app.inject({ method: 'GET', url: '/admin/kimi/version/lock' })).json()).toMatchObject({
      locked_version: null,
      locked_at: null,
    });
    await app.close();
  });
  it('pins only Kimi and rejects unsupported older native releases', async () => {
    const { app, db } = await buildApp();
    db.tables.set(versions, [
      { name: 'client_version_lock', version: '0.137.0' },
      { name: 'client_version_lock_claude', version: '2.1.170' },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/kimi/version',
      payload: { selection: '2.5.4' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ locked_version: '2.5.4' });
    expect((await app.inject({ method: 'GET', url: '/admin/kimi/version/lock' })).json()).toMatchObject({
      locked_version: '2.5.4',
    });
    expect(
      (await app.inject({ method: 'POST', url: '/admin/kimi/version', payload: { selection: '2.5.2' } }))
        .statusCode,
    ).toBe(422);
    const rows = db.tables.get(versions) ?? [];
    expect(rows.find((row) => row.name === 'client_version_lock')?.version).toBe('0.137.0');
    expect(rows.find((row) => row.name === 'client_version_lock_claude')?.version).toBe('2.1.170');
    expect(rows.find((row) => row.name === 'client_version_lock_kimi')?.version).toBe('2.5.4');
    await app.close();
  });
  it('refreshes all four release sources and returns engine-specific summaries', async () => {
    const { app } = await buildApp();
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url) =>
        ({
          ok: true,
          text: async () => '2.5.3',
          json: async () =>
            String(url).includes('xai-official')
              ? { version: '2.5.3' }
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
      kimi_available_client: { name: 'kimi-cli', version: '2.5.3' },
      kimi_versions: { client_version: 'latest', client_version_lock: null },
    });
    expect(upstream).toHaveBeenCalledTimes(4);
    await app.close();
  });
});

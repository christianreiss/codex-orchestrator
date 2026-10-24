import { loadAdminAgentPreviewHost } from '../src/routes/admin/config/index.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.js';
import type { StateSeed } from '../src/control-plane/state/catalog.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../src/control-plane/state/runtime.js';
import { DeadlineQueue } from '../src/control-plane/deadlines.js';
import { createVersionSnapshotService } from '../src/services/version-snapshot.js';
import { createSurfaceRouting, listApiSurfaces } from '../src/services/api-surfaces.js';
import { makeOpenAiKillSwitch } from '../src/services/openai-kill-switch.js';

function fixture(seed: StateSeed = {}) {
  const select = vi.fn(() => {
    throw new Error('unexpected metadata SQL');
  });
  const db = { select } as unknown as Database;
  const epoch = randomUUID();
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch, sequence: 0n }, seed));
  let lost = false;
  const owner: OwnerRuntime = {
    state,
    deadlines: new DeadlineQueue(() => {}),
    assertOwner() {
      if (lost) throw new Error('owner lost');
    },
    execute: vi.fn(async () => {
      throw new Error('unexpected command');
    }),
  };
  bindOwnerRuntime(db, owner);
  return {
    db,
    select,
    state,
    epoch,
    lose() {
      lost = true;
    },
  };
}

describe('owned API metadata', () => {
  it('serves empty installation defaults for all engines without SQL', async () => {
    const f = fixture();
    const versions = createVersionSnapshotService({ db: f.db, installationId: 'install' });
    for (const engine of ['codex', 'claude', 'grok'] as const) {
      expect((await versions.summary(engine)).engine).toBe(engine);
      expect(await makeOpenAiKillSwitch(f.db, `${engine}_api_disabled`).isDisabled()).toBe(false);
    }
    expect(await versions.setting('missing')).toBeNull();
    expect(await versions.flag('missing', true)).toBe(true);
    expect((await listApiSurfaces(f.db)).map((row) => row.key_count)).toEqual([0, 0, 0]);
    expect(f.select).not.toHaveBeenCalled();
  });

  it('observes committed settings, routing and key changes immediately without a TTL', async () => {
    const f = fixture({
      versions: [{ name: 'client_version_codex', version: '1.2.3' }],
      openaiApiKeys: [{ id: 1, engine: 'codex', isActive: 1 }],
    } as unknown as StateSeed);
    const versions = createVersionSnapshotService({ db: f.db, installationId: null });
    const routing = createSurfaceRouting(f.db, 3_600_000);
    const kill = makeOpenAiKillSwitch(f.db);
    expect((await versions.summary()).client_version).toBe('1.2.3');
    expect(await routing.backendFor('openai')).toBe('codex');
    expect(await kill.isDisabled()).toBe(false);
    expect((await listApiSurfaces(f.db))[0]?.key_count).toBe(1);
    const draft = f.state.begin();
    for (const [name, version] of Object.entries({
      client_version_codex: '2.3.4',
      api_surface_backend_openai: 'grok',
      openai_api_disabled: '1',
      engine_disabled_claude: '1',
    }))
      draft.upsert('versions', { name, version, updatedAt: new Date().toISOString() });
    draft.upsert('openaiApiKeys', { ...draft.table('openaiApiKeys').get(1)!, isActive: 0 });
    f.state.publish(draft.seal({ epoch: f.epoch, sequence: 1n }));
    expect((await versions.summary()).client_version).toBe('2.3.4');
    expect(await versions.setting('api_surface_backend_openai')).toBe('grok');
    expect(await versions.flag('openai_api_disabled')).toBe(true);
    expect(await routing.backendFor('openai')).toBe('grok');
    expect(await kill.isDisabled()).toBe(true);
    await expect(kill.throwIfDisabled()).rejects.toThrow('disabled');
    expect((await listApiSurfaces(f.db))[0]).toMatchObject({ backend: 'grok', disabled: true, key_count: 0 });
    expect(f.select).not.toHaveBeenCalled();
  });

  it('loads only credential content for an admin preview while retaining current host metadata', async () => {
    const f = fixture({
      hosts: [{ id: 1, fqdn: 'current.test', apiKey: 'legacy-key', status: 'active', engines: 'codex' }],
    } as unknown as StateSeed);
    f.select.mockImplementation(
      () =>
        ({
          from: () => ({ where: () => ({ limit: async () => [{ apiKey: 'legacy-key', apiKeyEnc: null }] }) }),
        }) as never,
    );
    const host = await loadAdminAgentPreviewHost(f.db, 1);
    expect(host).toMatchObject({ fqdn: 'current.test', apiKey: 'legacy-key', apiKeyEnc: null });
    expect(Object.keys((f.select.mock.calls as unknown[][])[0]![0] as object)).toEqual([
      'apiKey',
      'apiKeyEnc',
    ]);
    expect(await loadAdminAgentPreviewHost(f.db, 2)).toBeUndefined();
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it('rejects host changes while preview credential content is being read', async () => {
    const f = fixture({
      hosts: [{ id: 1, fqdn: 'current.test', apiKey: 'legacy-key', status: 'active', engines: 'codex' }],
    } as unknown as StateSeed);
    f.select.mockImplementation(
      () =>
        ({
          from: () => ({
            where: () => ({
              limit: async () => {
                const draft = f.state.begin();
                draft.upsert('hosts', { ...draft.table('hosts').get(1)!, status: 'inactive' });
                f.state.publish(draft.seal({ epoch: f.epoch, sequence: 1n }));
                return [{ apiKey: 'legacy-key', apiKeyEnc: null }];
              },
            }),
          }),
        }) as never,
    );
    await expect(loadAdminAgentPreviewHost(f.db, 1)).rejects.toThrow('Host changed');
  });

  it('does not serve stale routing or fail open after owner loss', async () => {
    const f = fixture();
    const versions = createVersionSnapshotService({ db: f.db, installationId: null });
    const routing = createSurfaceRouting(f.db);
    const kill = makeOpenAiKillSwitch(f.db);
    await routing.backendFor('openai');
    await kill.isDisabled();
    f.lose();
    await expect(routing.backendFor('openai')).rejects.toThrow('owner lost');
    await expect(kill.isDisabled()).rejects.toThrow('owner lost');
    await expect(versions.summary()).rejects.toThrow('owner lost');
    await expect(versions.flag('x')).rejects.toThrow('owner lost');
    await expect(versions.setting('x')).rejects.toThrow('owner lost');
    await expect(listApiSurfaces(f.db)).rejects.toThrow('owner lost');
    expect(f.select).not.toHaveBeenCalled();
  });
});

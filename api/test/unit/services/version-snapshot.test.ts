import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  applyHostClientVersionPin,
  applyHostVersionPolicy,
  createVersionSnapshotService,
} from '../../../src/services/version-snapshot.js';

/**
 * Tests use a tiny in-memory db fake that mimics enough of Drizzle's select()
 * to satisfy version-snapshot. The service only ever does plain reads on the
 * `versions` table, so a fixed array of rows is enough.
 */
function makeDb(rows: Array<{ name: string; version: string }>) {
  return {
    select: () => ({
      from: (_t: unknown) => {
        const builder = {
          where: (w: ReturnType<typeof eq>) => ({
            limit: (_n: number) => {
              const sql = w as unknown as { queryChunks?: Array<{ value?: unknown[] }> };
              const value = sql.queryChunks?.find((chunk) => Array.isArray(chunk.value))?.value?.[0];
              return Promise.resolve(rows.filter((row) => row.name === value).slice(0, _n));
            },
          }),
          then(resolve: (rows: Array<{ name: string; version: string }>) => void) {
            resolve(rows);
          },
        };
        return builder;
      },
    }),
  } as unknown as Parameters<typeof createVersionSnapshotService>[0]['db'];
}

describe('version-snapshot', () => {
  it.each(['codex', 'claude'] as const)('reads only %s runner telemetry', async (engine) => {
    const db = makeDb([
      { name: 'runner_state', version: 'ok' },
      { name: 'runner_state_claude', version: 'fail' },
    ]);
    const service = createVersionSnapshotService({ db, installationId: null });
    expect((await service.summary(engine)).runner_state).toBe(engine === 'claude' ? 'fail' : 'ok');
  });

  it('does not report Codex runner success for an unprobed Claude runner', async () => {
    const db = makeDb([{ name: 'runner_state', version: 'ok' }]);
    const service = createVersionSnapshotService({ db, installationId: null });
    expect((await service.summary('claude')).runner_state).toBeNull();
  });

  it('returns engine-suffixed values when present', async () => {
    const db = makeDb([
      { name: 'client_version_codex', version: '0.42.0' },
      { name: 'wrapper_version_codex', version: '1.2.3' },
      { name: 'auto_update_enabled', version: '1' },
      { name: 'api_disabled', version: 'false' },
    ]);
    const svc = createVersionSnapshotService({ db, installationId: 'inst-42' });
    const s = await svc.summary('codex');
    expect(s.client_version).toBe('0.42.0');
    expect(s.wrapper_version).toBe('1.2.3');
    expect(s.auto_update_enabled).toBe(true);
    expect(s.api_disabled).toBe(false);
    expect(s.installation_id).toBe('inst-42');
    expect(s.engine).toBe('codex');
  });

  it('keeps legacy Codex client targets isolated while sharing wrapper metadata', async () => {
    const db = makeDb([
      { name: 'client_version', version: '0.9.9' },
      { name: 'wrapper_version', version: '0.5.0' },
    ]);
    const svc = createVersionSnapshotService({ db, installationId: null });
    const codex = await svc.summary('codex');
    const claude = await svc.summary('claude');
    expect(codex.client_version).toBe('0.9.9');
    expect(claude.client_version).toBeNull();
    expect(claude.wrapper_version).toBe('0.5.0');
    expect(claude.engine).toBe('claude');
  });

  it('honors a Claude exact lock without inheriting an unrelated legacy target', async () => {
    const db = makeDb([
      { name: 'client_version', version: '0.137.0' },
      { name: 'client_version_lock_claude', version: '2.1.200' },
    ]);
    const svc = createVersionSnapshotService({ db, installationId: null });
    expect(await svc.summary('claude')).toMatchObject({
      client_version: null,
      client_version_override: '2.1.200',
      client_version_enforce_exact: true,
    });
  });

  it('resolves latest codex alias from cached release metadata', async () => {
    const db = makeDb([
      { name: 'client_version_codex', version: 'latest' },
      { name: 'github_release_codex-cli', version: '{"tag_name":"rust-v0.137.0"}' },
      { name: 'client_available', version: '0.130.0' },
    ]);
    const svc = createVersionSnapshotService({ db, installationId: null });
    const s = await svc.summary('codex');
    expect(s.client_version).toBe('0.137.0');
  });

  it('refreshes latest codex metadata before resolving the target', async () => {
    const rows = [
      { name: 'client_version_codex', version: 'latest' },
      { name: 'github_release_codex-cli', version: '{"tag_name":"rust-v0.139.0"}' },
    ];
    const db = makeDb(rows);
    const svc = createVersionSnapshotService({
      db,
      installationId: null,
      refreshLatestClientVersion: async (engine) => {
        expect(engine).toBe('codex');
        rows[1] = { name: 'github_release_codex-cli', version: '{"tag_name":"rust-v0.140.0"}' };
      },
    });
    const s = await svc.summary('codex');
    expect(s.client_version).toBe('0.140.0');
  });

  it('falls back to cached available version for latest codex alias', async () => {
    const db = makeDb([
      { name: 'client_version_codex', version: 'latest' },
      { name: 'client_available', version: '0.130.0' },
    ]);
    const svc = createVersionSnapshotService({ db, installationId: null });
    const s = await svc.summary('codex');
    expect(s.client_version).toBe('0.130.0');
  });

  it('uses the settings codex lock as an exact cron override', async () => {
    const db = makeDb([
      { name: 'client_version_codex', version: 'latest' },
      { name: 'client_available', version: '0.130.0' },
      { name: 'client_version_lock', version: '0.125.0' },
    ]);
    const svc = createVersionSnapshotService({ db, installationId: null });
    const s = await svc.summary('codex');
    expect(s.client_version).toBe('0.130.0');
    expect(s.client_version_override).toBe('0.125.0');
    expect(s.client_version_enforce_exact).toBe(true);
  });

  it('reports when the release cache behind an aliased target was last fetched', async () => {
    // A failed upstream fetch keeps serving the expired cache rather than
    // breaking updates, so `fetched_at` ageing is the only outward signal that
    // the whole fleet is being handed a stale target.
    const db = makeDb([
      { name: 'client_version_claude', version: 'latest' },
      {
        name: 'github_release_claude-cli',
        version: '{"version":"2.1.225","fetched_at":"2026-08-06T09:00:00Z"}',
      },
    ]);
    const svc = createVersionSnapshotService({ db, installationId: null });
    const s = await svc.summary('claude');
    expect(s.client_version).toBe('2.1.225');
    expect(s.client_version_fetched_at).toBe('2026-08-06T09:00:00Z');
  });

  it('reports no fetch time for an explicit pin, which never reads the cache', async () => {
    const db = makeDb([
      { name: 'client_version_claude', version: '2.1.200' },
      {
        name: 'github_release_claude-cli',
        version: '{"version":"2.1.225","fetched_at":"2026-08-06T09:00:00Z"}',
      },
    ]);
    const svc = createVersionSnapshotService({ db, installationId: null });
    expect((await svc.summary('claude')).client_version_fetched_at).toBeNull();
  });
});

describe('applyHostVersionPolicy', () => {
  it.each(['codex', 'claude'] as const)('applies host enable/disable/inherit for %s without losing its version pin', (engine) => {
    for (const fleetEnabled of [true, false]) {
      for (const override of [null, undefined, 0, 1]) {
        const snapshot = {
          auto_update_enabled: fleetEnabled,
          client_version_override: null,
          client_version_enforce_exact: false,
        } as Parameters<typeof applyHostVersionPolicy>[0];
        const result = applyHostVersionPolicy(snapshot, {
          autoUpdateOverride: override,
          clientVersionOverride: '0.132.0',
          claudeClientVersionOverride: '2.1.200',
        }, engine);
        expect(result.auto_update_enabled).toBe(override == null ? fleetEnabled : override === 1);
        expect(result.client_version_override).toBe(engine === 'claude' ? '2.1.200' : '0.132.0');
        expect(result.client_version_enforce_exact).toBe(true);
        expect(snapshot.auto_update_enabled).toBe(fleetEnabled);
        expect(snapshot.client_version_override).toBeNull();
      }
    }
  });
});

/**
 * `summary()` only ever reads the global `versions` table, so without this the
 * `hosts.client_version_override` / `hosts.claude_client_version_override`
 * columns were write-only: the admin UI accepted a pin, echoed it back, and no
 * wrapper ever saw it.
 */
describe('applyHostClientVersionPin', () => {
  const base = {
    client_version: '2.1.225',
    client_version_override: null,
    client_version_enforce_exact: false,
  } as Parameters<typeof applyHostClientVersionPin>[0];

  it('overrides the fleet target and forces an exact match', () => {
    const pinned = applyHostClientVersionPin(
      base,
      { claudeClientVersionOverride: '2.1.200', clientVersionOverride: '0.132.0' },
      'claude',
    );
    expect(pinned.client_version_override).toBe('2.1.200');
    expect(pinned.client_version_enforce_exact).toBe(true);
    // The fleet target itself is untouched; only the override the wrapper
    // prefers changes.
    expect(pinned.client_version).toBe('2.1.225');
  });

  it('reads the column belonging to the requested engine', () => {
    const host = { claudeClientVersionOverride: '2.1.200', clientVersionOverride: '0.132.0' };
    expect(applyHostClientVersionPin(base, host, 'codex').client_version_override).toBe('0.132.0');
  });

  it('leaves the snapshot alone without a usable pin', () => {
    for (const host of [null, undefined, {}, { claudeClientVersionOverride: 'latest' }]) {
      expect(applyHostClientVersionPin(base, host, 'claude')).toBe(base);
    }
  });
});

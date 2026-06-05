import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createVersionSnapshotService } from '../../../src/services/version-snapshot.js';

/**
 * Tests use a tiny in-memory db shim that mimics enough of Drizzle's select()
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

  it('falls back to unsuffixed values when engine-specific are missing', async () => {
    const db = makeDb([
      { name: 'client_version', version: '0.9.9' },
      { name: 'wrapper_version', version: '0.5.0' },
    ]);
    const svc = createVersionSnapshotService({ db, installationId: null });
    const s = await svc.summary('claude');
    expect(s.client_version).toBe('0.9.9');
    expect(s.wrapper_version).toBe('0.5.0');
    expect(s.engine).toBe('claude');
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
});

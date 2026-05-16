import { describe, expect, it } from 'vitest';
import { createVersionSnapshotService } from '../../../src/services/version-snapshot.js';

/**
 * Tests use a tiny in-memory db shim that mimics enough of Drizzle's select()
 * to satisfy version-snapshot. The service only ever does plain reads on the
 * `versions` table, so a fixed array of rows is enough.
 */
function makeDbShim(rows: Array<{ name: string; version: string }>) {
  return {
    select: () => ({
      from: (_t: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => Promise.resolve(rows.filter((r) => r.name === (_w as { name?: string })?.name)),
        }),
        // Plain select with no .where used by readMap()
        then: (resolve: (rows: Array<{ name: string; version: string }>) => void) => resolve(rows),
      }),
    }),
  };
}

// The select chain accepts a `where(eq(...))` form for flag/setting; we
// emulate that via a smarter shim.
function makeDb(rows: Array<{ name: string; version: string }>) {
  return {
    select: () => ({
      from: (_t: unknown) => {
        const builder = {
          where: (_w: unknown) => ({
            limit: (_n: number) => {
              // The where() argument is opaque; in tests we ignore filter
              // and return the full row that matches `_w`. Instead just
              // return all rows — the service code uses `rows[0]?.version`
              // so when callers want a specific key they should make a shim
              // per-test.
              return Promise.resolve(rows.slice(0, 1));
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
});

// Silence unused-import warning
void makeDbShim;

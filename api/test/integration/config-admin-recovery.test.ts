import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { clientConfigDocuments } from '../../src/db/schema.js';
import { ClientConfigService } from '../../src/services/client-config.js';
import { runMigrations } from '../../src/db/migrator.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
describe.skipIf(!handle)('correct invalid authored native settings on MySQL', () => {
  const ids: number[] = [];
  beforeAll(async () => { await runMigrations(handle!.pool, { initSchema: true, appliedBy: 'config-admin-recovery-test' }); }, 120_000);
  afterAll(async () => {
    if (handle) {
      for (const id of ids) await handle.db.delete(clientConfigDocuments).where(eq(clientConfigDocuments.id, id));
      await handle.pool.end();
    }
  }, 120_000);
  it.each(['codex', 'claude', 'grok'] as const)('%s preserves the invalid snapshot and enforces correction/revision checks', async engine => {
    const service = new ClientConfigService(handle!.db);
    const settings = { native_settings: { unknown_saved_option: 'keep raw authored value' } };
    const body = `# historical ${engine} snapshot\n`, sha256 = createHash('sha256').update(body).digest('hex');
    const at = new Date().toISOString();
    const [inserted] = await handle!.db.insert(clientConfigDocuments).values({ engine, body, sha256, settings, createdAt: at, updatedAt: at });
    ids.push(inserted.insertId);
    const current = await service.adminFetch(engine);
    expect(current).toMatchObject({ status: 'ok', revision: String(inserted.insertId), content: body, sha256, settings,
      validation_error: { code: 'validation_failed', param: expect.stringContaining('unknown_saved_option') } });
    expect(() => service.render(current.settings, engine)).toThrow();
    await expect(service.store({ settings: current.settings, expected_revision: current.revision }, null, engine)).rejects.toMatchObject({ status: 422 });
    const corrected = { ...current.settings, native_settings: {} };
    const saved = await service.store({ settings: corrected, expected_revision: current.revision, sha256 }, null, engine);
    ids.push(Number(saved.revision));
    const latest = await service.adminFetch(engine);
    expect(latest.validation_error).toBeUndefined();
    expect(latest.revision).toBe(saved.revision);
    expect(latest.settings).toEqual(service.render(corrected, engine).settings);
    await expect(service.store({ settings: corrected, expected_revision: current.revision }, null, engine)).rejects.toMatchObject({ status: 409, code: 'config_revision_conflict' });
    const [historical] = await handle!.db.select().from(clientConfigDocuments).where(eq(clientConfigDocuments.id, inserted.insertId));
    expect(historical).toMatchObject({ body, sha256, settings });
  });
});

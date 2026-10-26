import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { clientConfigDocuments } from '../../src/db/schema.js';
import { ClientConfigService } from '../../src/services/client-config.js';
import { runMigrations } from '../../src/db/migrator.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Grok custom model contexts on MySQL', () => {
  const ids: number[] = [];
  beforeAll(async () => { await runMigrations(handle!.pool, { initSchema: true, appliedBy: 'grok-custom-context-test' }); });
  afterAll(async () => {
    if (handle) {
      for (const id of ids) await handle.db.delete(clientConfigDocuments).where(eq(clientConfigDocuments.id, id));
      await handle.pool.end();
    }
  });
  it('keeps custom tokens and siblings through create/edit/remove while enforcing revisions', async () => {
    const service = new ClientConfigService(handle!.db);
    const first = await service.store({ settings: { native_settings: { model: { 'local.with.dot': { context_window: 128000, temperature: 0.2 } } } } }, null, 'grok');
    ids.push(Number(first.revision));
    const fetched = await service.adminFetch('grok');
    expect(fetched.validation_error).toBeUndefined();
    expect(fetched.settings?.native_settings).toEqual({ model: { 'local.with.dot': { context_window: 128000, temperature: 0.2 } } });
    const second = await service.store({ settings: { native_settings: { model: { 'local.with.dot': { context_window: 64000, temperature: 0.2 } } } }, expected_revision: first.revision }, null, 'grok');
    ids.push(Number(second.revision));
    await expect(service.store({ settings: first.settings, expected_revision: first.revision }, null, 'grok')).rejects.toMatchObject({ status: 409 });
    const removed = await service.store({ settings: { native_settings: { model: { 'local.with.dot': { temperature: 0.2 } } } }, expected_revision: second.revision }, null, 'grok');
    ids.push(Number(removed.revision));
    expect(removed.content).not.toContain('context_window = 64000');
    expect((await service.adminFetch('grok')).settings?.native_settings).toEqual({ model: { 'local.with.dot': { temperature: 0.2 } } });
    await expect(service.store({ settings: { native_settings: { model: { 'grok-4.7': { context_window: 128000 } } } } }, null, 'grok')).rejects.toMatchObject({ status: 422 });
  });
});

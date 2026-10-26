import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { clientConfigDocuments } from '../../src/db/schema.js';
import { ClientConfigService } from '../../src/services/client-config.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
const savedIds: number[] = [];

describe.skipIf(!handle)('Codex legacy model roundtrip on MySQL', () => {
  afterAll(async () => {
    if (!handle) return;
    if (savedIds.length) await handle.db.delete(clientConfigDocuments).where(inArray(clientConfigDocuments.id, savedIds));
    await handle.pool.end();
  });

  it('migrates actual stored references, preserves historical evidence and fences a concurrent save', async () => {
    const legacy = { model: 'gpt-5.4', model_reasoning_effort: 'low',
      native_settings: { review_model: 'gpt-5.4-mini', agents: { default_subagent_model: 'gpt-5.4-mini', default_subagent_reasoning_effort: 'ultra' } },
      profiles: [{ name: 'small', model: 'gpt-5.4-mini', model_reasoning_effort: 'xhigh' }] };
    const [inserted] = await handle!.db.insert(clientConfigDocuments).values({ engine: 'codex', settings: legacy,
      body: 'historical model config', sha256: '0'.repeat(64), createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' });
    savedIds.push(inserted.insertId);
    const service = new ClientConfigService(handle!.db);
    const first = await service.adminFetch('codex');
    expect(first.content).toBe('historical model config');
    expect(first.sha256).toBe('0'.repeat(64));
    expect(first.settings).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'low',
      native_settings: { review_model: 'gpt-6-luna', agents: { default_subagent_model: 'gpt-6-luna', default_subagent_reasoning_effort: 'medium' } },
      profiles: [{ name: 'small', model: 'gpt-6-luna', model_reasoning_effort: 'xhigh' }] });
    const winner = await service.store({ settings: first.settings, expected_revision: first.revision });
    savedIds.push(Number(winner.revision));
    expect(winner.revision).not.toBe(first.revision);
    expect(winner.content).toContain('model = "gpt-6-sol"');
    expect(winner.content).toContain('model_reasoning_effort = "low"');
    await expect(service.store({ settings: { ...first.settings, model_reasoning_effort: 'high' }, expected_revision: first.revision }))
      .rejects.toMatchObject({ status: 409, code: 'config_revision_conflict' });
    const saved = await service.adminFetch('codex');
    expect(saved.settings).toEqual(winner.settings);
    const removed = await service.store({ settings: { ...saved.settings, native_settings: {}, profiles: [] }, expected_revision: saved.revision });
    savedIds.push(Number(removed.revision));
    expect(removed.content).not.toContain('default_subagent_model');
    expect(removed.settings.profiles).toEqual([]);
    expect(removed.settings).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'low' });
  });
});

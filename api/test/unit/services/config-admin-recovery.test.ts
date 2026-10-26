import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ClientConfigService, renderTomlForHost, renderClaudeSettingsPartialForHost } from '../../../src/services/client-config.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { bindOwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { createDbFake } from '../../helpers/db-fake.js';

for (const owned of [false, true]) describe(`invalid saved native config (${owned ? 'owner RAM' : 'database'})`, () => {
  it.each(['codex', 'claude', 'grok'] as const)('%s remains readable and strict until corrected', async engine => {
    const settings = { native_settings: { unknown_saved_option: 'private-value-not-for-errors' } };
    const body = '# historical saved snapshot\n';
    const sha256 = createHash('sha256').update(body).digest('hex');
    const row = { id: 1, engine, body, sha256, settings, createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' };
    const db = createDbFake(new Map([[clientConfigDocuments, [structuredClone(row)]]]));
    const deadlines = new DeadlineQueue(error => { throw error; });
    if (owned) {
      const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, { clientConfigDocuments: [row] as never }));
      const executor = new CommandExecutor({
        state, assertOwner() {}, loseOwner(error) { throw error; }, committed() {}, notificationError(error) { throw error; },
        persistence: { async receipt() { return undefined; }, async transaction(run) { await run(db as unknown as PersistenceTransaction); }, async record() {} },
      });
      bindOwnerRuntime(db, { state, deadlines, assertOwner() {}, execute: command => executor.execute(command) });
    }
    const select = vi.spyOn(db, 'select');
    try {
      const service = new ClientConfigService(db as never);
      const result = await service.adminFetch(engine);
      expect(result).toMatchObject({ status: 'ok', revision: '1', content: body, sha256, settings,
        validation_error: { code: 'validation_failed', param: expect.stringContaining('unknown_saved_option') } });
      expect(result.validation_error?.message).not.toContain('private-value-not-for-errors');
      expect(() => service.render(result.settings, engine)).toThrow();
      const host = { clientVersion: '0.164.0', claudeClientVersion: '2.1.310', grokClientVersion: '1.0.70', wrapperVersion: '0.9.137', claudeWrapperVersion: '0.9.137', grokWrapperVersion: '0.9.137' } as never;
      expect(() => engine === 'claude'
        ? renderClaudeSettingsPartialForHost({ settings: result.settings, host, baseUrl: null, apiKey: null })
        : renderTomlForHost({ settings: result.settings, engine, host, baseUrl: null, apiKey: null })).toThrow();
      await expect(service.store({ settings: result.settings, expected_revision: '1' }, null, engine)).rejects.toMatchObject({ status: 422 });
      expect(db.inserts).toEqual([]);
      expect(db.tables.get(clientConfigDocuments)).toEqual([row]);
      if (owned) expect(select).not.toHaveBeenCalled();
      const corrected = { ...result.settings, native_settings: {} };
      const saved = await service.store({ settings: corrected, expected_revision: '1', sha256 }, null, engine);
      expect(saved.change).toBe('updated');
      if (!owned) db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
      const fetched = await service.adminFetch(engine);
      expect(fetched.validation_error).toBeUndefined();
      const failure = vi.spyOn(service, 'render').mockImplementationOnce(() => { throw new Error('unrelated renderer failure'); });
      await expect(service.adminFetch(engine)).rejects.toThrow('unrelated renderer failure');
      failure.mockRestore();
      expect(fetched.revision).toBe(saved.revision);
      expect(fetched.settings).toEqual(service.render(corrected, engine).settings);
      await expect(service.store({ settings: corrected, expected_revision: '1' }, null, engine)).rejects.toMatchObject({ status: 409, code: 'config_revision_conflict' });
    } finally { deadlines.close(); }
  });
});

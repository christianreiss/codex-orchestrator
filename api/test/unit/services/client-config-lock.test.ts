import { describe, expect, it, vi } from 'vitest';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { ModelDefaultsService } from '../../../src/services/model-defaults.js';
import { withClientConfigWriteLock } from '../../../src/services/client-config-lock.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake } from '../../helpers/db-fake.js';

describe('Canonical config write locking', () => {
  it('discards rollback notifications and publishes once after the successful commit', async () => {
    const db = createDbFake();
    const original = db.transaction.bind(db);
    let attempt = 0;
    let committed = false;
    const notify = vi.fn(() => { expect(committed).toBe(true); });
    vi.spyOn(db, 'transaction').mockImplementation(async (write, options) => {
      const result = await original(write, options);
      expect(notify).not.toHaveBeenCalled();
      if (++attempt === 1) throw new Error('rolled back', { cause: { errno: 1213 } });
      committed = true;
      return result;
    });
    await withClientConfigWriteLock(db as never, 'codex', async (_tx, _existing, context) => {
      context.afterCommit(notify);
    });
    expect(notify).toHaveBeenCalledOnce();
  });

  it.each(['config', 'model', 'provision'] as const)('publishes %s updates only after commit', async operation => {
    const db = createDbFake();
    const original = db.transaction.bind(db);
    let committed = false;
    vi.spyOn(db, 'transaction').mockImplementation(async (write, options) => {
      const result = await original(write, options);
      committed = true;
      return result;
    });
    const publish = vi.spyOn(wsPublisher, 'publish').mockImplementation(() => { expect(committed).toBe(true); });
    try {
      for (let save = 0; save < 2; save += 1) {
        if (operation === 'config') await new ClientConfigService(db as never).store({ settings: {} });
        else if (operation === 'model') await new ModelDefaultsService(db as never).set('claude', { model: 'claude-sonnet-5' });
        else await new ModelDefaultsService(db as never).ensureGrokDefaults();
      }
      // The second write is unchanged and has no invalidation to publish.
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      publish.mockRestore();
    }
  });

  it('retries an explicitly rolled-back MySQL deadlock and observes the winning head', async () => {
    const db = createDbFake();
    db.tables.set(clientConfigDocuments, [{ id: 3, engine: 'grok' }]);
    const original = db.transaction.bind(db);
    vi.spyOn(db, 'transaction')
      .mockRejectedValueOnce(new Error('query failed', { cause: { errno: 1213 } }))
      .mockImplementation(original);
    const write = vi.fn(async (_tx, existing: boolean) => existing);
    expect(await withClientConfigWriteLock(db as never, 'grok', write)).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(db.locks).toEqual([expect.objectContaining({ table: clientConfigDocuments, strength: 'update' })]);
  });

  it('bounds deadlock retries and never replays an uncertain connection failure', async () => {
    const db = createDbFake();
    const deadlock = new Error('rolled back', { cause: { code: 'ER_LOCK_DEADLOCK' } });
    const transaction = vi.spyOn(db, 'transaction').mockRejectedValue(deadlock);
    const write = vi.fn(async () => true);
    await expect(withClientConfigWriteLock(db as never, 'grok', write)).rejects.toBe(deadlock);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(write).not.toHaveBeenCalled();
    const disconnected = new Error('connection unavailable');
    transaction.mockClear().mockRejectedValue(disconnected);
    await expect(withClientConfigWriteLock(db as never, 'grok', write)).rejects.toBe(disconnected);
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('locks operator Grok writes and keeps saved digest conflicts effective', async () => {
    const db = createDbFake();
    const configs = new ClientConfigService(db as never);
    const saved = await configs.store({ settings: { model: 'grok-4.5', reasoning_effort: 'low' } }, null, 'grok');
    expect(saved.settings).toMatchObject({ model: 'grok-4.5', reasoning_effort: 'low' });
    expect(db.transactions).toEqual([{ isolationLevel: 'repeatable read' }]);
    expect(db.locks).toHaveLength(1);
    await expect(configs.store({ settings: { model: 'grok-4.6' }, sha256: 'f'.repeat(64) }, null, 'grok'))
      .rejects.toMatchObject({ status: 422, param: 'sha256' });
    expect(db.tables.get(clientConfigDocuments)).toHaveLength(1);
  });

  it.each(['codex', 'claude', 'grok'] as const)('guards the %s missing state and keeps omitted revisions compatible', async engine => {
    const db = createDbFake();
    const configs = new ClientConfigService(db as never);
    expect(await configs.adminFetch(engine)).toEqual({ status: 'missing', revision: null });
    const saved = await configs.store({ settings: {}, expected_revision: null }, null, engine);
    expect(saved.revision).toBe('1');
    expect((await configs.adminFetch(engine)).revision).toBe(saved.revision);
    await expect(configs.store({ settings: {}, expected_revision: null }, null, engine))
      .rejects.toMatchObject({ status: 409, code: 'config_revision_conflict' });
    expect((await configs.store({ settings: {} }, null, engine)).change).toBe('unchanged');
    expect(db.locks).toHaveLength(3);
  });

  it.each([0, false, '', ' 1', '0', '-1', '1.0', {}, []])('rejects malformed expected revisions: %j', async expected_revision => {
    const configs = new ClientConfigService(createDbFake() as never);
    await expect(configs.store({ settings: {}, expected_revision }))
      .rejects.toMatchObject({ status: 422, param: 'expected_revision' });
  });
});

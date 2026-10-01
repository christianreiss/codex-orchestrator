import { describe, expect, it, vi } from 'vitest';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { withGrokConfigWriteLock } from '../../../src/services/grok-config-lock.js';
import { createDbFake } from '../../helpers/db-fake.js';

describe('Grok canonical config write locking', () => {
  it('retries an explicitly rolled-back MySQL deadlock and observes the winning head', async () => {
    const db = createDbFake();
    db.tables.set(clientConfigDocuments, [{ id: 3, engine: 'grok' }]);
    const original = db.transaction.bind(db);
    vi.spyOn(db, 'transaction')
      .mockRejectedValueOnce(new Error('query failed', { cause: { errno: 1213 } }))
      .mockImplementation(original);
    const write = vi.fn(async (_tx, existing: boolean) => existing);
    expect(await withGrokConfigWriteLock(db as never, write)).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(db.locks).toEqual([expect.objectContaining({ table: clientConfigDocuments, strength: 'update' })]);
  });

  it('bounds deadlock retries and never replays an uncertain connection failure', async () => {
    const db = createDbFake();
    const deadlock = new Error('rolled back', { cause: { code: 'ER_LOCK_DEADLOCK' } });
    const transaction = vi.spyOn(db, 'transaction').mockRejectedValue(deadlock);
    const write = vi.fn(async () => true);
    await expect(withGrokConfigWriteLock(db as never, write)).rejects.toBe(deadlock);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(write).not.toHaveBeenCalled();
    const disconnected = new Error('connection unavailable');
    transaction.mockClear().mockRejectedValue(disconnected);
    await expect(withGrokConfigWriteLock(db as never, write)).rejects.toBe(disconnected);
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
});

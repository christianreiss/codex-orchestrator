import { describe, expect, it, vi } from 'vitest';
import { authoritativeSnapshot, executeColdRead, protectOwnerReadHandle, scopedDatabase } from '../../../src/db/fresh-read.js';
import type { Database } from '../../../src/db/client.js';
import { sql } from 'drizzle-orm';

describe('owner database boundary', () => {
  it('opens protected snapshots read-only without exposing writers and scopes explicit cold reads', async () => {
    const tx = { select: vi.fn(() => 'snapshot'), execute: vi.fn(async () => 'cold snapshot') };
    const raw = { select: vi.fn(() => 'pool'), execute: vi.fn(), transaction: vi.fn(async (run: (value: typeof tx) => Promise<unknown>, _options: unknown) => run(tx)) };
    const handle = scopedDatabase(raw);
    protectOwnerReadHandle(handle);
    await authoritativeSnapshot(handle as unknown as Database, async () => {
      expect(handle.select()).toBe('snapshot');
      for (const method of ['insert', 'update', 'delete', 'transaction', 'execute', '$client', 'session'])
        expect(() => Reflect.get(handle, method)).toThrow('Owner database boundary');
      expect(await executeColdRead(handle as unknown as Database, sql`SELECT 1`)).toBe('cold snapshot');
    });
    expect(raw.transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(raw.execute).not.toHaveBeenCalled();
    expect(handle.select()).toBe('pool');
  });
  it('revokes legacy writers including captured methods, leaving explicit cold reads available', async () => {
    const raw = {
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
      execute: vi.fn(async () => [[{ body: 'history' }]]),
      select: vi.fn(() => 'read'),
      $client: {},
    };
    const handle = scopedDatabase(raw);
    const beforeHydration = handle.update;
    handle.insert();
    expect(raw.insert).toHaveBeenCalledOnce();
    protectOwnerReadHandle(handle);
    for (const method of ['insert', 'update', 'delete', 'transaction', 'execute', '$client'])
      expect(() => Reflect.get(handle, method)).toThrow('Owner database boundary');
    expect(beforeHydration).toThrow('Owner database boundary');
    expect(raw.update).not.toHaveBeenCalled();
    expect(handle.select()).toBe('read');
    expect(await executeColdRead(handle as unknown as Database, sql`SELECT body FROM history`)).toEqual([
      [{ body: 'history' }],
    ]);
    expect(raw.execute).toHaveBeenCalledOnce();
  });

  it('does not impose the public read boundary on separate owner persistence handles', () => {
    const transaction = { insert: vi.fn() };
    protectOwnerReadHandle(transaction);
    transaction.insert();
    expect(transaction.insert).toHaveBeenCalledOnce();
  });
});

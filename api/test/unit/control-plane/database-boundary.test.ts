import { describe, expect, it, vi } from 'vitest';
import { executeColdRead, protectOwnerReadHandle, scopedDatabase } from '../../../src/db/fresh-read.js';
import type { Database } from '../../../src/db/client.js';
import { sql } from 'drizzle-orm';

describe('owner database boundary', () => {
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

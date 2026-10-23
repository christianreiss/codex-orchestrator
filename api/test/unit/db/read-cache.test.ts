import { describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { installReadCache } from '../../../src/db/read-cache.js';
import { authoritativeReads } from '../../../src/db/fresh-read.js';

type Row = { id: number; name: string; meta: { tag: string } };

function fakePool() {
  const rows: Row[] = [
    { id: 1, name: 'one', meta: { tag: 'a' } },
    { id: 2, name: 'two', meta: { tag: 'b' } },
  ];
  const calls: string[] = [];
  let gate: Promise<void> | null = null;
  const fields = [{ name: 'id', orgName: 'id', table: 'hosts', orgTable: 'hosts' }, { name: 'name', orgName: 'name', table: 'hosts', orgTable: 'hosts' }];
  const run = async (arg: unknown, values?: unknown[]) => {
    const sql = typeof arg === 'string' ? arg : (arg as { sql: string }).sql;
    const bound = (values ?? (arg as { values?: unknown[] }).values ?? []) as unknown[];
    calls.push(sql);
    if (gate) await gate;
    if (/^update/i.test(sql)) {
      const id = Number(bound[bound.length - 1]);
      const row = rows.find((r) => r.id === id);
      if (row) row.name = String(bound[0]);
      return [{ affectedRows: row ? 1 : 0 }, undefined];
    }
    if (/^select/i.test(sql)) {
      const match = /where `hosts`\.`id` = \?/.test(sql) ? rows.filter((r) => r.id === Number(bound[0])) : rows;
      return [match.map((r) => [r.id, r.name, structuredClone(r.meta)]), fields];
    }
    return [{}, undefined];
  };
  const connection = {
    query: run,
    execute: run,
    released: 0,
    release() {
      this.released++;
    },
  };
  const pool = {
    query: run,
    execute: run,
    getConnection: async () => ({ ...connection }),
  };
  return {
    pool: pool as unknown as Pool,
    calls,
    rows,
    hold() {
      let open!: () => void;
      gate = new Promise<void>((resolve) => (open = resolve));
      return () => {
        gate = null;
        open();
      };
    },
  };
}

const byId = 'select `id`, `name`, `meta` from `hosts` where `hosts`.`id` = ? limit ?';
const all = 'select `id`, `name`, `meta` from `hosts`';
const rename = 'update `hosts` set `name` = ? where `hosts`.`id` = ?';
const tables = { hosts: { uniqueColumns: ['id'], rowKey: 'id' }, versions: { uniqueColumns: ['name'] } };
const allTables = ['hosts', 'versions', 'agent_sessions'];

describe('db read cache', () => {
  it('never proves freshness from a cached row, including out-of-process edits', async () => {
    const fake = fakePool();
    installReadCache(fake.pool, { tables, allTables });
    await fake.pool.query({ sql: byId, rowsAsArray: true } as never, [1, 1]);
    fake.rows[0]!.name = 'outside writer';
    const stale = await fake.pool.query({ sql: byId, rowsAsArray: true } as never, [1, 1]);
    const fresh = await authoritativeReads(async () => await fake.pool.query({ sql: byId, rowsAsArray: true } as never, [1, 1]));
    expect((stale[0] as unknown[][])[0]?.[1]).toBe('one');
    expect((fresh[0] as unknown[][])[0]?.[1]).toBe('outside writer');
  });
  it('serves a repeated pool-level select from memory, as an isolated copy', async () => {
    const fake = fakePool();
    installReadCache(fake.pool, { tables, allTables });
    const first = (await fake.pool.query({ sql: byId, rowsAsArray: true } as never, [1, 1])) as unknown as [unknown[][]];
    (first[0][0]![2] as { tag: string }).tag = 'mutated';
    const second = (await fake.pool.query({ sql: byId, rowsAsArray: true } as never, [1, 1])) as unknown as [unknown[][]];
    expect(fake.calls.filter((c) => c === byId)).toHaveLength(1);
    expect(second[0][0]![2]).toEqual({ tag: 'a' });
  });

  it('drops only the written row for a single-row unique lookup, and every list', async () => {
    const fake = fakePool();
    const cache = installReadCache(fake.pool, { tables, allTables });
    await fake.pool.query(byId, [1, 1]);
    await fake.pool.query(byId, [2, 1]);
    await fake.pool.query(all);
    await fake.pool.query(rename, ['uno', 1]);
    const one = (await fake.pool.query(byId, [1, 1])) as unknown as [unknown[][]];
    await fake.pool.query(byId, [2, 1]);
    await fake.pool.query(all);
    expect(one[0][0]![1]).toBe('uno');
    // Re-read: host 1 and the list; host 2 stayed cached.
    expect(fake.calls.filter((c) => c === byId)).toHaveLength(3);
    expect(fake.calls.filter((c) => c === all)).toHaveLength(2);
    expect(cache.stats().hits).toBe(1);
  });

  it('bypasses while a transaction holds a write and re-reads after commit', async () => {
    const fake = fakePool();
    installReadCache(fake.pool, { tables, allTables });
    await fake.pool.query(byId, [1, 1]);
    const conn = await fake.pool.getConnection();
    await conn.query('begin');
    await conn.query(rename, ['uno', 1]);
    await fake.pool.query(byId, [2, 1]);
    await fake.pool.query(byId, [2, 1]);
    // Both reads of host 2 went to MySQL: nothing is cached while the write is open.
    expect(fake.calls.filter((c) => c === byId)).toHaveLength(3);
    await conn.query('commit');
    conn.release();
    const after = (await fake.pool.query(byId, [1, 1])) as unknown as [unknown[][]];
    expect(after[0][0]![1]).toBe('uno');
    await fake.pool.query(byId, [1, 1]);
    expect(fake.calls.filter((c) => c === byId)).toHaveLength(4);
  });

  it('settles a rolled back or abandoned transaction', async () => {
    const fake = fakePool();
    const cache = installReadCache(fake.pool, { tables, allTables });
    const conn = await fake.pool.getConnection();
    await conn.query('begin');
    await conn.query(rename, ['uno', 1]);
    await conn.query('rollback');
    conn.release();
    const abandoned = await fake.pool.getConnection();
    await abandoned.query('start transaction');
    await abandoned.query(rename, ['dos', 2]);
    abandoned.release();
    await fake.pool.query(byId, [1, 1]);
    await fake.pool.query(byId, [1, 1]);
    expect(cache.stats().hits).toBe(1);
  });

  it('does not store a load that a write overtook', async () => {
    const fake = fakePool();
    const cache = installReadCache(fake.pool, { tables, allTables });
    const release = fake.hold();
    const pending = fake.pool.query(byId, [1, 1]);
    const write = fake.pool.query(rename, ['uno', 1]);
    release();
    await Promise.all([pending, write]);
    await fake.pool.query(byId, [1, 1]);
    expect(cache.stats().hits).toBe(0);
  });

  it('never caches locking, non-deterministic or foreign-table reads', async () => {
    const fake = fakePool();
    const cache = installReadCache(fake.pool, { tables, allTables });
    for (const sql of [
      `${byId} for update`,
      'select `id` from `hosts` where `last_contact_at` > now()',
      'select `hosts`.`id` from `hosts` inner join `agent_sessions` on `agent_sessions`.`host_id` = `hosts`.`id`',
      'select id from hosts where exists (select 1 from agent_sessions)',
    ]) {
      await fake.pool.query(sql, [1, 1]);
      await fake.pool.query(sql, [1, 1]);
    }
    expect(cache.stats().hits).toBe(0);
    expect(cache.stats().entries).toBe(0);
  });

  it('serves transactional reads unless that transaction wrote the table', async () => {
    const fake = fakePool();
    const cache = installReadCache(fake.pool, { tables, allTables });
    await fake.pool.query(byId, [1, 1]);
    const conn = await fake.pool.getConnection();
    await conn.query('begin');
    await conn.query(byId, [1, 1]);
    expect(cache.stats().hits).toBe(1);
    await conn.query(rename, ['uno', 1]);
    const own = (await conn.query(byId, [1, 1])) as unknown as [unknown[][]];
    expect(own[0][0]![1]).toBe('uno');
    expect(cache.stats().hits).toBe(1);
    await conn.query('commit');
    conn.release();
  });

  it('invalidates exactly the rows another process changed', async () => {
    const fake = fakePool();
    const cache = installReadCache(fake.pool, { tables: { hosts: tables.hosts }, allTables, resyncMs: 0 });
    const resync = () => (cache as unknown as { resync(): Promise<void> }).resync();
    await resync();
    await fake.pool.query(byId, [1, 1]);
    await fake.pool.query(byId, [2, 1]);
    await resync();
    await fake.pool.query(byId, [1, 1]);
    expect(cache.stats().hits).toBe(1);
    // Written behind the API's back: only host 1 is re-read.
    fake.rows[0]!.name = 'external';
    await resync();
    const one = (await fake.pool.query(byId, [1, 1])) as unknown as [unknown[][]];
    await fake.pool.query(byId, [2, 1]);
    expect(one[0][0]![1]).toBe('external');
    expect(cache.stats()).toMatchObject({ hits: 2, resyncFlushes: 1 });
  });
});

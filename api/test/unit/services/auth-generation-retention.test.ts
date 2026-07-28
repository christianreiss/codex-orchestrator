import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import {
  AUTH_HISTORY_RETENTION_DAYS,
  ensureAuthGenerationBackfill,
  pruneSupersededAuth,
  retentionDeadline,
} from '../../../src/services/auth-generation-retention.js';
import { authCanonicalHeads } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import type { Keyring } from '../../../src/security/keyring.js';

const dialect = new MySqlDialect();

type Row = Record<string, unknown>;

interface Statement {
  sql: string;
  params: unknown[];
}

interface DeleteCall extends Statement {
  inTransaction: boolean;
}

interface PruneRecorder {
  db: Database;
  /** The `and(lt(purge_after), lt(superseded_at))` clause the candidate select emitted. */
  candidateWhere: Statement | null;
  deletes: DeleteCall[];
  transactions: number;
}

/**
 * Hand-rolled recording stub: createDbFake cannot express the retention window
 * (its filterRows only understands `=` and `is null`), so the eligible rows are
 * seeded straight through select() and every statement the pruner emits is read
 * back out of the SQL it built.
 */
function createPruneRecorder(heads: Row[], candidates: Row[]): PruneRecorder {
  const recorder = {
    candidateWhere: null,
    deletes: [],
    transactions: 0,
  } as unknown as PruneRecorder;
  let inTransaction = false;
  const stub = {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === authCanonicalHeads ? heads : candidates;
        const builder = Promise.resolve(rows) as Promise<Row[]> & {
          where: (where: SQL) => Promise<Row[]>;
        };
        builder.where = (where: SQL) => {
          recorder.candidateWhere = dialect.sqlToQuery(where);
          return Promise.resolve(candidates);
        };
        return builder;
      },
    }),
    delete: (_table: unknown) => ({
      where: (where: SQL) => {
        recorder.deletes.push({ ...dialect.sqlToQuery(where), inTransaction });
        return Promise.resolve([{ affectedRows: 0 }]);
      },
    }),
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      recorder.transactions += 1;
      inTransaction = true;
      try {
        return await cb(stub);
      } finally {
        inTransaction = false;
      }
    },
  };
  recorder.db = stub as unknown as Database;
  return recorder;
}

/** `payload_id in (?, ?)` -> the bound ids, so the delete set is read from SQL. */
function deletedIds(call: Statement): number[] {
  expect(call.sql).toMatch(/ in \(/);
  return call.params as number[];
}

/** The qualified column an `inArray` delete filtered on, e.g. auth_entries.payload_id. */
function deleteTarget(call: Statement): string {
  const match = /`?(\w+)`?\.`?(\w+)`? in \(/.exec(call.sql);
  expect(match, call.sql).not.toBeNull();
  return `${match![1]}.${match![2]}`;
}

const NOW = '2026-07-29T00:00:00.000Z';
const LONG_AGO = '2026-01-01T00:00:00.000Z';

/** A superseded row whose purge deadline is well behind `NOW`. */
function candidate(id: number): Row {
  return { id, engine: 'codex', supersededAt: LONG_AGO, purgeAfter: LONG_AGO };
}

describe('auth generation retention', () => {
  it('starts the 180-day clock at supersession', () => {
    const superseded = '2026-07-20T10:00:00.000Z';
    expect(retentionDeadline(superseded)).toBe(
      new Date(Date.parse(superseded) + AUTH_HISTORY_RETENTION_DAYS * 86_400_000).toISOString(),
    );
  });

  it('rejects malformed supersession timestamps', () => {
    expect(() => retentionDeadline('not-a-date')).toThrow('invalid auth superseded_at');
  });
});

describe('pruneSupersededAuth', () => {
  it('selects only rows whose purge deadline and supersession are behind now', async () => {
    const recorder = createPruneRecorder([], [candidate(1)]);

    await pruneSupersededAuth(recorder.db, NOW);

    expect(recorder.candidateWhere?.sql).toContain('purge_after');
    expect(recorder.candidateWhere?.sql).toContain('superseded_at');
    expect(recorder.candidateWhere?.sql).toContain('<');
    expect(recorder.candidateWhere?.params).toEqual([NOW, NOW]);
  });

  it('never deletes a payload referenced by a canonical head', async () => {
    const recorder = createPruneRecorder(
      [
        { engine: 'codex', payloadId: 7 },
        { engine: 'claude', payloadId: 9 },
      ],
      // Every row is past its deadline, including both live canonical heads.
      [candidate(7), candidate(8), candidate(9), candidate(10)],
    );

    const removed = await pruneSupersededAuth(recorder.db, NOW);

    expect(removed).toBe(2);
    for (const call of recorder.deletes) {
      expect(deletedIds(call)).toEqual([8, 10]);
      expect(deletedIds(call)).not.toContain(7);
      expect(deletedIds(call)).not.toContain(9);
    }
  });

  it('caps the batch at the limit and excludes heads before the slice', async () => {
    const recorder = createPruneRecorder(
      [{ engine: 'codex', payloadId: 2 }],
      [1, 2, 3, 4, 5, 6].map(candidate),
    );

    const removed = await pruneSupersededAuth(recorder.db, NOW, 3);

    // Slicing before the head filter would yield [1, 3] -- two ids, not three.
    expect(removed).toBe(3);
    expect(deletedIds(recorder.deletes[0]!)).toEqual([1, 3, 4]);
  });

  it('defaults the batch to the 500 the retention worker drains on', async () => {
    const ids = Array.from({ length: 501 }, (_, index) => index + 1);
    const recorder = createPruneRecorder([], ids.map(candidate));

    const removed = await pruneSupersededAuth(recorder.db, NOW);

    expect(removed).toBe(500);
    expect(deletedIds(recorder.deletes[0]!)).toHaveLength(500);
    expect(deletedIds(recorder.deletes[0]!).at(-1)).toBe(500);
  });

  it('deletes host states, entries and payloads for one id set in one transaction', async () => {
    const recorder = createPruneRecorder([], [candidate(4), candidate(5)]);

    const removed = await pruneSupersededAuth(recorder.db, NOW);

    expect(removed).toBe(2);
    expect(recorder.transactions).toBe(1);
    expect(recorder.deletes.map(deleteTarget)).toEqual([
      'host_auth_states.payload_id',
      'auth_entries.payload_id',
      'auth_payloads.id',
    ]);
    for (const call of recorder.deletes) {
      expect(deletedIds(call)).toEqual([4, 5]);
      expect(call.inTransaction).toBe(true);
    }
  });

  it('opens no transaction when nothing is eligible', async () => {
    const recorder = createPruneRecorder([{ engine: 'codex', payloadId: 3 }], []);

    expect(await pruneSupersededAuth(recorder.db, NOW)).toBe(0);
    expect(recorder.transactions).toBe(0);
    expect(recorder.deletes).toEqual([]);
  });

  it('opens no transaction when every eligible row is head-protected', async () => {
    const recorder = createPruneRecorder([{ engine: 'codex', payloadId: 3 }], [candidate(3)]);

    expect(await pruneSupersededAuth(recorder.db, NOW)).toBe(0);
    expect(recorder.transactions).toBe(0);
    expect(recorder.deletes).toEqual([]);
  });
});

describe('ensureAuthGenerationBackfill', () => {
  it('short-circuits without writing once the ledger marker reads complete', async () => {
    const selects: Statement[] = [];
    const refuse = (verb: string) => () => {
      throw new Error(`unexpected ${verb} after the backfill marker was complete`);
    };
    const db = {
      select: () => ({
        from: (_table: unknown) => ({
          where: (where: SQL) => {
            selects.push(dialect.sqlToQuery(where));
            return Promise.resolve([
              { name: 'auth_generation_ledger_v1', version: 'complete', updatedAt: LONG_AGO },
            ]);
          },
        }),
      }),
      insert: refuse('insert'),
      update: refuse('update'),
      delete: refuse('delete'),
      transaction: refuse('transaction'),
    } as unknown as Database;

    await ensureAuthGenerationBackfill(db, {} as unknown as Keyring);

    expect(selects).toHaveLength(1);
    expect(selects[0]!.params).toEqual(['auth_generation_ledger_v1']);
  });
});

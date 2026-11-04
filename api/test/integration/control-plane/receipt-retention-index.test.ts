import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import type { OwnerMutationContext } from '../../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { purgeCold } from '../../../src/services/server-retention/cold.js';
import { DEFAULT_SERVER_RETENTION } from '../../../src/services/server-retention/policy.js';

const dialect = new MySqlDialect();

describe('receipt retention indexed mutation predicates', () => {
  it.each(['delete', 'expire'] as const)(
    'keeps each primary-key lookup indexable and byte-exact when receipts %s',
    async (action) => {
      // A full batch catches a misplaced OR/AND group. Shared request IDs across
      // distinct principals must remain independent composite-key candidates.
      const candidates = Array.from({ length: 100 }, (_, index) => ({
        principal: index === 0 ? "host:' OR 1=1 --" : `host:${index}`,
        request_id: 'same-request-id',
        at: '2000-01-01T00:00:00.000Z',
      }));
      const queries: ReturnType<MySqlDialect['sqlToQuery']>[] = [];
      let selections = 0;
      const tx = {
        async execute(statement: SQL) {
          const query = dialect.sqlToQuery(statement);
          queries.push(query);
          if (query.sql.startsWith('SELECT')) {
            selections++;
            return [action === 'expire' && selections === 1 ? [] : candidates];
          }
          return [{ affectedRows: candidates.length }];
        },
      } as unknown as PersistenceTransaction;
      const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }));
      const context = { snapshot: state.snapshot(), draft: state.begin() } as OwnerMutationContext;
      expect(await purgeCold(context, tx, 'receipts', {
        ...DEFAULT_SERVER_RETENTION, armed: true,
      })).toBe(100);

      const mutation = queries.at(-1)!;
      expect(mutation.sql.startsWith(action === 'delete' ? 'DELETE FROM' : 'UPDATE')).toBe(true);
      const predicate = mutation.sql.split(' WHERE ')[1]!;
      const branches = predicate.split(' OR ');
      expect(branches).toHaveLength(candidates.length);
      for (const branch of branches) {
        // Bare-column equalities expose both PK parts to MySQL's range planner;
        // BINARY residuals preserve exact bytes even under a legacy CI collation.
        expect(branch).toMatch(/^\(principal=\? AND request_id=\? AND BINARY principal=BINARY \? AND BINARY request_id=BINARY \?\)$/);
      }
      expect(mutation.params).toEqual(candidates.flatMap(row => [
        row.principal, row.request_id, row.principal, row.request_id,
      ]));
      expect(mutation.sql).not.toContain(candidates[0]!.principal);
      if (action === 'expire') {
        expect(mutation.sql).toContain("SET result_enc=NULL,result_state='expired'");
      }
    },
  );
});

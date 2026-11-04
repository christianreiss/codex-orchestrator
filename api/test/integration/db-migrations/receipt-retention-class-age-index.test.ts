import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import { loadMigrations } from '../../../src/db/migrator.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import type { OwnerMutationContext } from '../../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { coldClock, purgeCold } from '../../../src/services/server-retention/cold.js';
import { DEFAULT_SERVER_RETENTION } from '../../../src/services/server-retention/policy.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb();
const dialect = new MySqlDialect();
const policy = { ...DEFAULT_SERVER_RETENTION, armed: true };

describe.skipIf(!handle)('receipt retention class/age index migration', () => {
  afterAll(async () => { await handle?.pool.end(); });
  it('upgrades twice and seeks internal clocks and cleanup past older external history', async () => {
    const connection = await handle!.pool.getConnection();
    const database = 'receipt_index_' + randomUUID().replaceAll('-', '');
    const [current] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS name');
    const now = Date.parse('2026-11-04T12:00:00.000Z');
    const day = 86_400_000;
    const at = (days: number, offset = 0) => new Date(now - days * day + offset).toISOString();
    try {
      await connection.query('CREATE DATABASE ??', [database]);
      await connection.query('USE ??', [database]);
      await connection.query(`CREATE TABLE control_plane_command_receipts (
        principal VARCHAR(191) NOT NULL, request_id VARCHAR(64) NOT NULL,
        replay_class VARCHAR(16) NOT NULL, result_state VARCHAR(16) NOT NULL,
        result_enc LONGTEXT, created_at VARCHAR(100) NOT NULL,
        PRIMARY KEY(principal,request_id), KEY command_receipts_retention(created_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
      // The live failure walked older external/legacy rows before reaching the
      // seven-day internal boundary; newer internals dominate the table.
      for (let batch = 0; batch < 20; batch++) {
        const rows = Array.from({ length: 500 }, (_, i) => [
          'host:test', `${batch}:${i}`, batch < 2 ? (i % 2 ? 'external' : 'legacy') : 'internal',
          'available', 'retained', at(batch < 2 ? 10 : 1),
        ]);
        await connection.query('INSERT INTO control_plane_command_receipts VALUES ?', [rows]);
      }
      await connection.query('INSERT INTO control_plane_command_receipts VALUES ?', [[
        ['host:test', 'due', 'internal', 'available', 'retained', at(7, -1)],
        ['host:test', 'next', 'internal', 'available', 'retained', at(7, 1000)],
        ['host:test', 'unknown-class', 'future-class', 'available', 'retained', at(10)],
      ]]);
      const migration = (await loadMigrations()).find(m => m.version === '0123')!;
      expect(migration).toBeDefined();
      for (let run = 0; run < 2; run++) {
        for (const statement of migration.statements) await connection.query(statement);
        const [indexes] = await connection.query<RowDataPacket[]>(
          "SHOW INDEX FROM control_plane_command_receipts WHERE Key_name='command_receipts_class_age'",
        );
        expect(indexes.map(row => row.Column_name)).toEqual(['replay_class', 'created_at']);
        expect(indexes[0]?.Non_unique).toBe(1);
      }
      await connection.query('ANALYZE TABLE control_plane_command_receipts');
      const plans: RowDataPacket[] = [];
      const tx = {
        async execute(statement: SQL) {
          const query = dialect.sqlToQuery(statement);
          if (query.sql.startsWith('SELECT') && query.sql.includes("replay_class='internal'")) {
            const [plan] = await connection.query<RowDataPacket[]>('EXPLAIN ' + query.sql, query.params);
            plans.push(plan[0]!);
            // Past probes and cleanup must skip the older external prefix.
            // A future LIMIT 1 may cheaply use the existing age index because
            // its first row is already internal; leave that optimizer choice.
            if (query.sql.includes('<=')) expect(plan[0]?.key).toBe('command_receipts_class_age');
            expect(plan[0]?.type).toBe('range');
          }
          return connection.query(query.sql, query.params);
        },
      } as unknown as PersistenceTransaction;
      const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }));
      const context = { snapshot: state.snapshot(), draft: state.begin() } as OwnerMutationContext;
      expect(await coldClock(tx, 'receipts', now, policy)).toEqual({ past: true, next: now + 1000 });
      await connection.beginTransaction();
      expect(await purgeCold(context, tx, 'receipts', policy, now)).toBe(1);
      await connection.commit();
      expect(await coldClock(tx, 'receipts', now, policy)).toEqual({ past: false, next: now + 1000 });
      expect(plans).toHaveLength(5); // Two clocks and the real FOR UPDATE cleanup query.
      expect(plans.filter(plan => plan.key === 'command_receipts_class_age').length).toBeGreaterThanOrEqual(3);
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT request_id,result_enc FROM control_plane_command_receipts WHERE request_id IN (?,?,?)',
        ['due', 'next', 'unknown-class'],
      );
      expect(rows.map(row => row.request_id).sort()).toEqual(['next', 'unknown-class']);
      expect(rows.every(row => row.result_enc === 'retained')).toBe(true);
      const [count] = await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM control_plane_command_receipts');
      expect(Number(count[0]?.n)).toBe(10_002);
    } finally {
      await connection.rollback();
      await connection.query('USE ??', [current[0]!.name]);
      await connection.query('DROP DATABASE IF EXISTS ??', [database]);
      connection.release();
    }
  }, 60_000);
});

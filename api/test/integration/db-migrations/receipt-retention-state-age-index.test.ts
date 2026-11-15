import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import { loadMigrations } from '../../../src/db/migrator.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { coldClock } from '../../../src/services/server-retention/cold.js';
import { DEFAULT_SERVER_RETENTION } from '../../../src/services/server-retention/policy.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb(), dialect = new MySqlDialect();
describe.skipIf(!handle)('receipt retention state/age index migration', () => {
  afterAll(async () => { await handle?.pool.end(); });
  it('skips expired history with a covering seek, preserves clocks and upgrades idempotently', async () => {
    const connection = await handle!.pool.getConnection(), database = 'receipt_state_' + randomUUID().replaceAll('-', '');
    const [current] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS name');
    const now = Date.parse('2026-11-15T12:00:00.000Z'), day = 86_400_000;
    const at = (days: number) => new Date(now - days * day).toISOString();
    try {
      await connection.query('CREATE DATABASE ??', [database]);
      await connection.query('USE ??', [database]);
      await connection.query(`CREATE TABLE control_plane_command_receipts (
        principal VARCHAR(191) NOT NULL, request_id VARCHAR(64) NOT NULL,
        replay_class VARCHAR(16) NOT NULL, result_state VARCHAR(16) NOT NULL,
        result_enc LONGTEXT, created_at VARCHAR(100) NOT NULL,
        PRIMARY KEY(principal,request_id), KEY command_receipts_retention(created_at),
        KEY command_receipts_class_age(replay_class,created_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
      // The production past clock read 30,546 expired rows to find one
      // available result. Keep enough expired history to exercise that plan.
      for (let batch = 0; batch < 40; batch++) {
        const rows = Array.from({ length: 500 }, (_, i) => [
          'host:test', `${batch}:${i}`, 'legacy', 'expired', null, at(20),
        ]);
        await connection.query('INSERT INTO control_plane_command_receipts VALUES ?', [rows]);
      }
      await connection.query('INSERT INTO control_plane_command_receipts VALUES ?', [[
        ['host:test', 'due', 'external', 'available', 'retained', at(16)],
        ['host:test', 'unknown', 'future-class', 'available', 'retained', at(1)],
      ]]);
      let past: ReturnType<MySqlDialect['sqlToQuery']> | undefined;
      const tx = { async execute(statement: SQL) {
        const query = dialect.sqlToQuery(statement);
        if (query.sql.includes("replay_class<>'internal'") && query.sql.includes('<=?')) past = query;
        return connection.query(query.sql, query.params);
      } } as unknown as PersistenceTransaction;
      const policy = { ...DEFAULT_SERVER_RETENTION, armed: true };
      const before = await coldClock(tx, 'receipts', now, policy);
      expect(past).toBeDefined();
      const [oldPlan] = await connection.query<RowDataPacket[]>('EXPLAIN ANALYZE ' + past!.sql, past!.params);
      expect(String(oldPlan[0]!.EXPLAIN)).toMatch(/rows=20001 loops=1/);
      const migration = (await loadMigrations()).find(row => row.version === '0131')!;
      expect(migration).toBeDefined();
      for (let run = 0; run < 2; run++) {
        for (const statement of migration.statements) await connection.query(statement);
        const [indexes] = await connection.query<RowDataPacket[]>("SHOW INDEX FROM control_plane_command_receipts WHERE Key_name='command_receipts_state_age'");
        expect(indexes.map(row => row.Column_name)).toEqual(['result_state', 'created_at', 'replay_class']);
      }
      await connection.query('ANALYZE TABLE control_plane_command_receipts');
      const [plan] = await connection.query<RowDataPacket[]>('EXPLAIN ' + past!.sql, past!.params);
      expect(plan[0]!.key).toBe('command_receipts_state_age');
      expect(plan[0]!.Extra).toContain('Using index');
      const [actual] = await connection.query<RowDataPacket[]>('EXPLAIN ANALYZE ' + past!.sql, past!.params);
      expect(String(actual[0]!.EXPLAIN)).toMatch(/rows=1 loops=1/);
      expect(String(actual[0]!.EXPLAIN)).not.toMatch(/rows=20001 loops=1/);
      expect(await coldClock(tx, 'receipts', now, policy)).toEqual(before);
      const [count] = await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM control_plane_command_receipts');
      expect(Number(count[0]!.n)).toBe(20002);
    } finally {
      await connection.query('USE ??', [current[0]!.name]);
      await connection.query('DROP DATABASE IF EXISTS ??', [database]);
      connection.release();
    }
  }, 60_000);
});

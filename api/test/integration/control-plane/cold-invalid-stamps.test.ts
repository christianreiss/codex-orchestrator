import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { describe, expect, it, vi } from 'vitest';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import type { OwnerMutationContext } from '../../../src/control-plane/state/runtime.js';
import { coldClock, purgeCold } from '../../../src/services/server-retention/cold.js';
import { DEFAULT_SERVER_RETENTION } from '../../../src/services/server-retention/policy.js';
import { readDbConfig } from '../../helpers/test-db.js';

const config = readDbConfig(),
  policy = { ...DEFAULT_SERVER_RETENTION, armed: true };
describe.skipIf(!config)('invalid legacy cold timestamps on indexed MySQL', () => {
  it.each(['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'])(
    '%s: skips invalid clock pages and preserves invalid rows',
    async (collation) => {
      const pool = mysql.createPool({ ...config!, connectionLimit: 1 });
      const connection = await pool.getConnection(),
        database = 'cold_invalid_' + randomUUID().replaceAll('-', '');
      const [current] = await connection.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name');
      const previous = String(current[0]!.name);
      try {
        await connection.query(`CREATE DATABASE \`${database}\``);
        await connection.query(`USE \`${database}\``);
        await connection.query(`CREATE TABLE logs (id BIGINT PRIMARY KEY, created_at VARCHAR(100) NOT NULL,
        INDEX idx_logs_created_at(created_at)) CHARACTER SET utf8mb4 COLLATE ${collation}`);
        const db = drizzle(connection),
          dialect = new MySqlDialect();
        const queries: ReturnType<MySqlDialect['sqlToQuery']>[] = [];
        const tx = {
          execute: async (statement: Parameters<typeof db.execute>[0]) => {
            queries.push(dialect.sqlToQuery(statement as Parameters<MySqlDialect['sqlToQuery']>[0]));
            return db.execute(statement);
          },
        } as unknown as PersistenceTransaction;
        const valid = '2026-10-12T00:00:00.000Z',
          invalid = '2026-10-11T99:00:00Z';
        const stamps = [
          ...Array<string>(200).fill(invalid),
          ...Array.from(
            { length: 150 },
            (_, n) =>
              `2026-10-11T99:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z`,
          ),
          valid,
        ];
        await connection.query('INSERT INTO logs(id,created_at) VALUES ?', [
          stamps.map((at, id) => [id + 1, at]),
        ]);
        const clock = await coldClock(tx, 'auditlogs', Date.parse('2026-10-25T00:00:00Z'), policy);
        expect(clock).toEqual({ past: false, next: Date.parse(valid) + policy.audit_days * 86_400_000 });
        expect(queries.length).toBeLessThan(10);
        const future = queries.filter((query) => query.sql.includes('>?'));
        expect(future.length).toBeGreaterThan(2);
        const last = future.at(-1)!;
        const [plan] = await connection.execute<mysql.RowDataPacket[]>('EXPLAIN ' + last.sql, last.params as string[]);
        expect(plan[0]!.key).toBe('idx_logs_created_at');
        expect(plan[0]!.type).toBe('range');

        // Deletion authority is unchanged: malformed rows remain, while the valid
        // successor is selected and removed at the real scheduled deadline.
        await connection.query('DELETE FROM logs');
        await connection.query('INSERT INTO logs(id,created_at) VALUES (1,?),(2,?),(3,?)', [
          invalid,
          invalid,
          valid,
        ]);
        const context = {
          snapshot: {},
          draft: { table: () => ({ get: () => undefined }), upsert: vi.fn() },
        } as unknown as OwnerMutationContext;
        await connection.beginTransaction();
        expect(await purgeCold(context, tx, 'auditlogs', policy, clock.next!)).toBe(1);
        await connection.commit();
        const [retained] = await connection.query<mysql.RowDataPacket[]>(
          'SELECT created_at FROM logs ORDER BY id',
        );
        expect(retained.map((row) => row.created_at)).toEqual([invalid, invalid]);
      } finally {
        await connection.rollback();
        await connection.query(`USE \`${previous.replaceAll('`', '``')}\``);
        await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
        connection.release();
        await pool.end();
      }
    },
  );
});

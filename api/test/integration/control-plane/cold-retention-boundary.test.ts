import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { describe, expect, it, vi } from 'vitest';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import type { OwnerMutationContext } from '../../../src/control-plane/state/runtime.js';
import { coldClock, purgeCold } from '../../../src/services/server-retention/cold.js';
import { DEFAULT_SERVER_RETENTION } from '../../../src/services/server-retention/policy.js';
import { readDbConfig } from '../../helpers/test-db.js';

const config = readDbConfig();
const policy = { ...DEFAULT_SERVER_RETENTION, armed: true };
const cases = [
  ['2026-10-11T12:00:00Z', 1000],
  ['2026-10-11T12:00:00.1Z', 900],
  ['2026-10-11T12:00:00.12Z', 880],
  ['2026-10-11T12:00:00.123Z', 0],
  ['2026-10-11T12:00:00.123456Z', 877],
  ['2026-10-11T12:00:00.1+00:00', 900],
  ['2026-10-11T12:00:00.123456+00:00', 877],
  ['2026-10-11T12:00:00.999Z', 0],
  ['2026-10-11T12:00:59Z', 1000],
  ['2026-10-11T23:59:59.99Z', 10],
  ['2026-10-11T23:59:59Z', 1000],
  ['2026-10-11T12:00:00+00:00', 1000],
  ['2026-10-11T12:00:00.12+00:00', 880],
  ['2026-10-11T12:00:00.123+00:00', 877],
] as const;

function context() {
  return {
    draft: { table: () => ({ get: () => undefined }), upsert: vi.fn() },
  } as unknown as OwnerMutationContext;
}

describe.skipIf(!config)('cold retention boundaries on indexed MySQL text', () => {
  it.each(['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'])(
    'selects a real deletable batch at its first planned deadline (%s)',
    async (collation) => {
      const pool = mysql.createPool({ ...config!, connectionLimit: 1 });
      const connection = await pool.getConnection();
      const database = 'retention_boundary_' + randomUUID().replaceAll('-', '');
      const [current] = await connection.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name');
      const previous = String(current[0]!.name);
      try {
        await connection.query(`CREATE DATABASE \`${database}\``);
        await connection.query(`USE \`${database}\``);
        await connection.query(`CREATE TABLE logs (id BIGINT PRIMARY KEY, created_at VARCHAR(100) NOT NULL,
          INDEX idx_logs_created_at(created_at)) CHARACTER SET utf8mb4 COLLATE ${collation}`);
        const tx = drizzle(connection) as unknown as PersistenceTransaction;
        for (const [at, boundaryDelay] of cases) {
          const due = Date.parse(at) + policy.audit_days * 86_400_000;
          await connection.query('INSERT INTO logs(id,created_at) VALUES (1,?)', [at]);
          const clock = await coldClock(tx, 'auditlogs', due - 1, policy);
          expect(clock, at).toEqual({ past: false, next: due + boundaryDelay });
          await connection.beginTransaction();
          expect(await purgeCold(context(), tx, 'auditlogs', policy, due - 1), at).toBe(0);
          await connection.rollback();
          // Exercise actual FOR UPDATE / DELETE and rollback, then commit the
          // same selection. No copied SQL predicate stands in for production.
          await connection.beginTransaction();
          expect(await purgeCold(context(), tx, 'auditlogs', policy, clock.next!), at).toBe(1);
          await connection.rollback();
          const [retained] = await connection.query<mysql.RowDataPacket[]>('SELECT id FROM logs');
          expect(retained, at).toHaveLength(1);
          await connection.beginTransaction();
          expect(await purgeCold(context(), tx, 'auditlogs', policy, clock.next!), at).toBe(1);
          await connection.commit();
          expect(await coldClock(tx, 'auditlogs', clock.next!, policy), at).toEqual({
            past: false,
            next: null,
          });
        }
        const mixed = [
          '2026-10-11T23:59:59Z',
          '2026-10-11T23:59:59.1+00:00',
          '2026-10-11T23:59:59.120Z',
          '2026-10-11T23:59:59.123456Z',
          '2026-10-12T00:00:00.001Z',
        ];
        for (const [id, at] of mixed.entries())
          await connection.query('INSERT INTO logs(id,created_at) VALUES (?,?)', [id + 1, at]);
        let now = Date.parse(mixed[0]!) + policy.audit_days * 86_400_000 - 1;
        let remaining = mixed.length;
        for (let pass = 0; pass < 10 && remaining; pass++) {
          const clock = await coldClock(tx, 'auditlogs', now, policy);
          if (!clock.past) {
            expect(clock.next).not.toBeNull();
            expect(clock.next!).toBeGreaterThan(now);
            now = clock.next!;
          }
          const [before] = await connection.query<mysql.RowDataPacket[]>('SELECT id,created_at FROM logs');
          await connection.beginTransaction();
          const changed = await purgeCold(context(), tx, 'auditlogs', policy, now);
          await connection.commit();
          const [after] = await connection.query<mysql.RowDataPacket[]>('SELECT id FROM logs');
          const retained = new Set(after.map((row) => row.id));
          for (const row of before)
            if (!retained.has(row.id))
              expect(Date.parse(String(row.created_at)) + policy.audit_days * 86_400_000).toBeLessThanOrEqual(
                now,
              );
          remaining = after.length;
          if (!changed && remaining) {
            expect(clock.next).not.toBeNull();
            expect(clock.next!).toBeGreaterThan(now);
            now = clock.next!;
          }
        }
        expect(remaining).toBe(0);
        expect(now).toBeLessThanOrEqual(Date.parse(mixed.at(-1)!) + policy.audit_days * 86_400_000 + 1000);
        expect(await coldClock(tx, 'auditlogs', now, policy)).toEqual({ past: false, next: null });
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

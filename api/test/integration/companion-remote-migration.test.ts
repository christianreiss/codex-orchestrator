import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
const tables = [
  'host_daemon_portal_bindings',
  'companion_daemon_follows',
  'host_daemon_operations',
  'host_daemon_sessions',
  'companion_devices',
  'agent_sessions',
];
const prefix = 'remote_collation_test_';

describe.skipIf(!handle)(
  'remote conversation migration with production collation history',
  { timeout: 90_000 },
  () => {
    afterAll(async () => {
      if (!handle) return;
      for (const table of tables) await handle.pool.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
      await handle.pool.query(`DROP PROCEDURE IF EXISTS ${prefix}add_fk`);
      await handle.pool.end();
    });

    it('copies each referenced collation, backfills existing bindings and replays safely', async () => {
      const db = await handle!.pool.getConnection();
      try {
        await db.query(
          `CREATE TABLE ${prefix}agent_sessions (id CHAR(36) PRIMARY KEY) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        );
        await db.query(
          `CREATE TABLE ${prefix}host_daemon_sessions (id CHAR(36) PRIMARY KEY, session_id CHAR(36)) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
        await db.query(
          `CREATE TABLE ${prefix}companion_devices (id CHAR(36) PRIMARY KEY) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
        await db.query(`CREATE TABLE ${prefix}host_daemon_operations (id CHAR(36) PRIMARY KEY)`);
        const id = '891f3673-d7e0-4cfb-99e6-a5919a7cf398';
        await db.query(`INSERT INTO ${prefix}agent_sessions (id) VALUES (?)`, [id]);
        await db.query(`INSERT INTO ${prefix}host_daemon_sessions (id, session_id) VALUES (?, ?)`, [id, id]);
        let migration = await readFile(
          new URL('../../src/db/migrations/0052_companion_remote_conversations.sql', import.meta.url),
          'utf8',
        );
        for (const table of tables) migration = migration.replaceAll(table, prefix + table);
        migration = migration
          .replaceAll('companion_remote_add_fk', prefix + 'add_fk')
          .replaceAll('fk_daemon_', 'rc_test_fk_daemon_')
          .replaceAll('fk_companion_', 'rc_test_fk_companion_');
        const statements = splitSqlStatements(migration);
        for (let run = 0; run < 2; run++) for (const statement of statements) await db.query(statement);
        const [bindings] = await db.query<RowDataPacket[]>(
          `SELECT * FROM ${prefix}host_daemon_portal_bindings`,
        );
        expect(bindings).toEqual([{ portal_session_id: id, daemon_session_id: id }]);
        const [constraints] = await db.query<RowDataPacket[]>(
          "SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME LIKE 'rc_test_fk_%'",
        );
        expect(constraints).toHaveLength(4);
        const [columns] = await db.query<RowDataPacket[]>(
          'SELECT COLUMN_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
          [prefix + 'host_daemon_portal_bindings'],
        );
        expect(columns).toEqual(
          expect.arrayContaining([
            { COLUMN_NAME: 'portal_session_id', COLLATION_NAME: 'utf8mb4_unicode_ci' },
            { COLUMN_NAME: 'daemon_session_id', COLLATION_NAME: 'utf8mb4_0900_ai_ci' },
          ]),
        );
      } finally {
        db.release();
      }
    });
  },
);

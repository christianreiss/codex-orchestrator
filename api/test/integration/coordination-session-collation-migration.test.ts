import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
const prefix = 'scope_collation_test_';
const tables = ['agent_scope_members', 'agent_resource_claims', 'agent_sessions'];

describe.skipIf(!handle)('coordination session collation repair', { timeout: 90_000 }, () => {
  afterAll(async () => {
    if (!handle) return;
    for (const table of tables) await handle.pool.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
    await handle.pool.end();
  });

  it.each([
    ['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'],
    ['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci'],
  ])('restores membership and retention joins with sessions %s and coordination %s', async (sessions, scopes) => {
    const db = await handle!.pool.getConnection();
    try {
      for (const table of tables) await db.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
      await db.query(`CREATE TABLE ${prefix}agent_sessions (id CHAR(36) PRIMARY KEY)
        CHARACTER SET utf8mb4 COLLATE ${sessions}`);
      for (const table of tables.slice(0, 2)) await db.query(`CREATE TABLE ${prefix}${table} (
        id CHAR(36) PRIMARY KEY, session_id CHAR(36) NOT NULL, purpose VARCHAR(255) NOT NULL,
        UNIQUE KEY session_request (session_id, id)) CHARACTER SET utf8mb4 COLLATE ${scopes}`);
      const id = '891f3673-d7e0-4cfb-99e6-a5919a7cf398';
      await db.query(`INSERT INTO ${prefix}agent_sessions VALUES (?)`, [id]);
      for (const table of tables.slice(0, 2)) {
        await db.query(`INSERT INTO ${prefix}${table} VALUES (?, ?, ?)`, [id, id, 'Koordination prüfen']);
        await expect(db.query(`SELECT c.id FROM ${prefix}${table} c
          JOIN ${prefix}agent_sessions s ON c.session_id=s.id`))
          .rejects.toMatchObject({ code: 'ER_CANT_AGGREGATE_2COLLATIONS' });
      }
      let migration = await readFile(new URL('../../src/db/migrations/0089_coordination_session_collation.sql', import.meta.url), 'utf8');
      for (const table of tables) migration = migration.replaceAll(table, prefix + table);
      for (let run = 0; run < 2; run++) {
        for (const statement of splitSqlStatements(migration)) await db.query(statement);
        for (const table of tables.slice(0, 2)) {
          const [joined] = await db.query<RowDataPacket[]>(`SELECT c.id, c.session_id, c.purpose
            FROM ${prefix}${table} c JOIN ${prefix}agent_sessions s ON c.session_id=s.id`);
          expect(joined).toEqual([{ id, session_id: id, purpose: 'Koordination prüfen' }]);
          const [columns] = await db.query<RowDataPacket[]>(`SELECT COLUMN_NAME, COLLATION_NAME
            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
            AND COLUMN_NAME IN ('session_id', 'purpose') ORDER BY COLUMN_NAME`, [prefix + table]);
          expect(columns).toEqual([
            { COLUMN_NAME: 'purpose', COLLATION_NAME: scopes },
            { COLUMN_NAME: 'session_id', COLLATION_NAME: sessions },
          ]);
        }
      }
    } finally { db.release(); }
  });
});

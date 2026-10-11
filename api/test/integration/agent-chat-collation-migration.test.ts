import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
const prefix = 'chat_collation_test_';
const tables = ['agent_chat_notices', 'agent_chat_attachments', 'agent_sessions'];

describe.skipIf(!handle)('rich-chat session collation repair', { timeout: 90_000 }, () => {
  afterAll(async () => {
    if (!handle) return;
    for (const table of tables) await handle.pool.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
    await handle.pool.end();
  });

  it.each([
    ['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'],
    ['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci'],
  ])('preserves rows and restores joins with Portal %s and chat %s', async (portal, chat) => {
    const db = await handle!.pool.getConnection();
    try {
      for (const table of tables) await db.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
      await db.query(`CREATE TABLE ${prefix}agent_sessions (id CHAR(36) PRIMARY KEY)
        CHARACTER SET utf8mb4 COLLATE ${portal}`);
      for (const table of tables.slice(0, 2)) {
        await db.query(`CREATE TABLE ${prefix}${table} (id CHAR(36) PRIMARY KEY,
          session_id CHAR(36) NOT NULL, payload_enc LONGTEXT NOT NULL,
          resolved_at VARCHAR(100), INDEX session_idx (session_id, resolved_at))
          CHARACTER SET utf8mb4 COLLATE ${chat}`);
      }
      const id = '891f3673-d7e0-4cfb-99e6-a5919a7cf398';
      await db.query(`INSERT INTO ${prefix}agent_sessions VALUES (?)`, [id]);
      for (const table of tables.slice(0, 2)) {
        await db.query(`INSERT INTO ${prefix}${table} VALUES (?, ?, ?, NULL)`, [id, id, 'opaque-encrypted-payload']);
      }
      const overview = `SELECT s.id FROM ${prefix}agent_sessions s WHERE EXISTS
        (SELECT 1 FROM ${prefix}agent_chat_notices n WHERE n.session_id=s.id AND n.resolved_at IS NULL)`;
      await expect(db.query(overview)).rejects.toMatchObject({ code: 'ER_CANT_AGGREGATE_2COLLATIONS' });

      let migration = await readFile(new URL('../../src/db/migrations/0058_agent_chat_session_collation.sql', import.meta.url), 'utf8');
      for (const table of tables) migration = migration.replaceAll(table, prefix + table);
      const statements = splitSqlStatements(migration);
      for (let run = 0; run < 2; run++) {
        for (const statement of statements) await db.query(statement);
        const [visible] = await db.query<RowDataPacket[]>(overview);
        expect(visible).toEqual([{ id }]);
        for (const table of tables.slice(0, 2)) {
          const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${prefix}${table}`);
          expect(rows).toEqual([{ id, session_id: id, payload_enc: 'opaque-encrypted-payload', resolved_at: null }]);
          const [columns] = await db.query<RowDataPacket[]>(
            `SELECT CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME='session_id'`, [prefix + table]);
          expect(columns).toEqual([{ CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: portal }]);
          const [joined] = await db.query<RowDataPacket[]>(`SELECT c.id FROM ${prefix}${table} c
            JOIN ${prefix}agent_sessions s ON c.session_id=s.id`);
          expect(joined).toEqual([{ id }]);
        }
      }
    } finally { db.release(); }
  });
});

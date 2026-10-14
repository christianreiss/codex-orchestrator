import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
const prefix = 'daemon_collation_test_';
// Children before parents so DROP TABLE never trips a foreign key.
const tables = [
  'agent_chat_attachments',
  'host_daemon_operations',
  'companion_daemon_follows',
  'host_daemon_portal_bindings',
  'host_daemon_sessions',
  'agent_sessions',
];
const fkNames = ['fk_daemon_portal_remote', 'fk_companion_daemon_remote', 'host_daemon_operations_session_id_host_daemon_sessions_id_fk'];

// Prefixed copies of the canonical FK names; the long Drizzle name would exceed 64 chars.
const fkRename = (fk: string) => (fk.length > 40 ? `${prefix}ops_fk` : `${prefix}${fk}`);

function rewrite(sql: string): string {
  for (const fk of fkNames) sql = sql.replaceAll(fk, fkRename(fk));
  for (const table of tables) sql = sql.replace(new RegExp(`(?<![A-Za-z0-9_])${table}(?![A-Za-z0-9_])`, 'g'), prefix + table);
  return sql.replaceAll('daemon_session_collation_', `${prefix}proc_`);
}

// The shape of AgentChatAttachmentService.purge(): one attachment session ID
// compared against Portal and daemon session IDs in a single statement.
const purge = `SELECT a.id FROM ${prefix}agent_chat_attachments a
  LEFT JOIN ${prefix}agent_sessions s ON s.id = a.session_id
  LEFT JOIN ${prefix}host_daemon_sessions d ON d.id = a.session_id
  WHERE (s.id IS NULL AND NOT EXISTS (SELECT 1 FROM ${prefix}host_daemon_portal_bindings b
      INNER JOIN ${prefix}agent_sessions s2 ON s2.id = b.portal_session_id WHERE b.daemon_session_id = a.session_id))
    OR (a.status IN ('uploading', 'ready') AND a.updated_at < ?)
  LIMIT 100`;

async function dropAll(db: PoolConnection) {
  for (const table of tables) await db.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
}

describe.skipIf(!handle)('daemon session collation repair (0065)', { timeout: 90_000 }, () => {
  afterAll(async () => {
    if (!handle) return;
    const db = await handle.pool.getConnection();
    try { await dropAll(db); } finally { db.release(); }
    await handle.pool.end();
  });

  it.each([
    ['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'],
    ['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci'],
  ])('aligns daemon IDs with Portal %s (daemon family %s) and keeps rows and FKs', async (portal, daemon) => {
    const db = await handle!.pool.getConnection();
    try {
      await dropAll(db);
      // Production shape: Portal tables and 0058-aligned chat session_id on one
      // collation, the newer daemon family on the database default.
      await db.query(`CREATE TABLE ${prefix}agent_sessions (id CHAR(36) PRIMARY KEY) CHARACTER SET utf8mb4 COLLATE ${portal}`);
      await db.query(`CREATE TABLE ${prefix}host_daemon_sessions (id CHAR(36) PRIMARY KEY,
          session_id CHAR(36) NULL, address_id CHAR(36) NULL, title VARCHAR(160) NOT NULL,
          UNIQUE KEY uq_addr (address_id)) CHARACTER SET utf8mb4 COLLATE ${daemon}`);
      await db.query(`CREATE TABLE ${prefix}host_daemon_portal_bindings (
          portal_session_id CHAR(36) CHARACTER SET utf8mb4 COLLATE ${portal} NOT NULL PRIMARY KEY,
          daemon_session_id CHAR(36) NOT NULL, KEY idx_daemon (daemon_session_id),
          CONSTRAINT ${prefix}fk_daemon_portal_remote FOREIGN KEY (daemon_session_id)
            REFERENCES ${prefix}host_daemon_sessions (id) ON DELETE CASCADE) CHARACTER SET utf8mb4 COLLATE ${daemon}`);
      await db.query(`CREATE TABLE ${prefix}companion_daemon_follows (device_id CHAR(36) NOT NULL,
          daemon_session_id CHAR(36) NOT NULL, PRIMARY KEY (device_id, daemon_session_id),
          CONSTRAINT ${prefix}fk_companion_daemon_remote FOREIGN KEY (daemon_session_id)
            REFERENCES ${prefix}host_daemon_sessions (id) ON DELETE CASCADE) CHARACTER SET utf8mb4 COLLATE ${daemon}`);
      // Hand-migrated installations carry an auto-generated FK name; it must survive.
      await db.query(`CREATE TABLE ${prefix}host_daemon_operations (id CHAR(36) PRIMARY KEY,
          session_id CHAR(36) NOT NULL, status VARCHAR(24) NOT NULL,
          CONSTRAINT ${prefix}ops_ibfk_2 FOREIGN KEY (session_id)
            REFERENCES ${prefix}host_daemon_sessions (id) ON DELETE CASCADE) CHARACTER SET utf8mb4 COLLATE ${daemon}`);
      await db.query(`CREATE TABLE ${prefix}agent_chat_attachments (id CHAR(36) PRIMARY KEY,
          session_id CHAR(36) CHARACTER SET utf8mb4 COLLATE ${portal} NOT NULL,
          status VARCHAR(16) NOT NULL, updated_at VARCHAR(100) NOT NULL) CHARACTER SET utf8mb4 COLLATE ${daemon}`);

      const portalId = '891f3673-d7e0-4cfb-99e6-a5919a7cf398';
      const daemonId = '0b7d6f43-6c39-4c55-9a43-2a54d9c7f0de';
      const staleId = 'c9a5f6f1-3d5e-4f0e-8a1e-6f3b7e0f6a11';
      await db.query(`INSERT INTO ${prefix}agent_sessions VALUES (?)`, [portalId]);
      await db.query(`INSERT INTO ${prefix}host_daemon_sessions VALUES (?, ?, NULL, 'remote')`, [daemonId, portalId]);
      await db.query(`INSERT INTO ${prefix}host_daemon_portal_bindings VALUES (?, ?)`, [portalId, daemonId]);
      await db.query(`INSERT INTO ${prefix}companion_daemon_follows VALUES (?, ?)`, [staleId, daemonId]);
      await db.query(`INSERT INTO ${prefix}host_daemon_operations VALUES (?, ?, 'accepted')`, [staleId, daemonId]);
      await db.query(`INSERT INTO ${prefix}agent_chat_attachments VALUES (?, ?, 'linked', '2026-10-14T00:00:00Z'),
          (?, ?, 'linked', '2026-10-14T00:00:00Z'), (?, ?, 'ready', '2000-01-01T00:00:00Z')`,
        [portalId, portalId, daemonId, daemonId, staleId, portalId]);

      const cutoff = '2026-01-01T00:00:00Z';
      await expect(db.query(purge, [cutoff])).rejects.toMatchObject({ code: 'ER_CANT_AGGREGATE_2COLLATIONS' });

      const sql = rewrite(await readFile(new URL('../../src/db/migrations/0065_daemon_session_collation.sql', import.meta.url), 'utf8'));
      const statements = splitSqlStatements(sql);
      for (let run = 0; run < 2; run++) {
        for (const statement of statements) await db.query(statement);

        const [purged] = await db.query<RowDataPacket[]>(purge, [cutoff]);
        expect(purged).toEqual([{ id: staleId }]);

        const [columns] = await db.query<RowDataPacket[]>(
          `SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE '${prefix}%' AND COLLATION_NAME IS NOT NULL
             AND COLUMN_NAME IN ('id', 'session_id', 'daemon_session_id', 'portal_session_id', 'address_id', 'title')`);
        const off = columns.filter((c) => c.COLLATION_NAME !== portal
          && !(c.TABLE_NAME === `${prefix}agent_chat_attachments` && c.COLUMN_NAME === 'id')
          && !(c.TABLE_NAME === `${prefix}host_daemon_operations` && c.COLUMN_NAME === 'id'));
        expect(off).toEqual([]);
        // Untouched: columns that never hold a daemon session ID keep their collation.
        expect(columns.filter((c) => c.TABLE_NAME === `${prefix}host_daemon_operations` && c.COLUMN_NAME === 'id'))
          .toEqual([{ TABLE_NAME: `${prefix}host_daemon_operations`, COLUMN_NAME: 'id', COLLATION_NAME: daemon }]);

        const [fks] = await db.query<RowDataPacket[]>(
          `SELECT TABLE_NAME, CONSTRAINT_NAME, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
           WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME=? ORDER BY TABLE_NAME`, [`${prefix}host_daemon_sessions`]);
        expect(fks).toEqual([
          { TABLE_NAME: `${prefix}companion_daemon_follows`, CONSTRAINT_NAME: `${prefix}fk_companion_daemon_remote`, DELETE_RULE: 'CASCADE' },
          { TABLE_NAME: `${prefix}host_daemon_operations`, CONSTRAINT_NAME: `${prefix}ops_ibfk_2`, DELETE_RULE: 'CASCADE' },
          { TABLE_NAME: `${prefix}host_daemon_portal_bindings`, CONSTRAINT_NAME: `${prefix}fk_daemon_portal_remote`, DELETE_RULE: 'CASCADE' },
        ]);

        const [joined] = await db.query<RowDataPacket[]>(`SELECT d.id FROM ${prefix}host_daemon_sessions d
          JOIN ${prefix}agent_sessions s ON s.id = d.session_id
          JOIN ${prefix}host_daemon_portal_bindings b ON b.daemon_session_id = d.id
          JOIN ${prefix}companion_daemon_follows f ON f.daemon_session_id = d.id
          JOIN ${prefix}host_daemon_operations o ON o.session_id = d.id`);
        expect(joined).toEqual([{ id: daemonId }]);
      }

      // A replay after a crash between dropping and re-adding an FK restores it.
      await db.query(`ALTER TABLE ${prefix}host_daemon_portal_bindings DROP FOREIGN KEY ${prefix}fk_daemon_portal_remote`);
      for (const statement of statements) await db.query(statement);
      const [restored] = await db.query<RowDataPacket[]>(
        `SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=?`, [`${prefix}host_daemon_portal_bindings`]);
      expect(restored).toEqual([{ CONSTRAINT_NAME: `${prefix}fk_daemon_portal_remote` }]);
    } finally { db.release(); }
  });
});

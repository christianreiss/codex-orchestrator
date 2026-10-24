import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
const prefix = 'mcp_retire_test_';
const tables = ['mcp_access_logs', 'mcp_access_logs_retired', 'admin_events', 'versions', 'logs'];

describe.skipIf(!handle)('retiring generic MCP access logs', () => {
  afterAll(async () => {
    if (!handle) return;
    for (const table of tables) await handle.pool.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
    await handle.pool.end();
  });

  it.each(['live', 'copied_before_interruption'] as const)('preserves credential-read audits from %s and can be repeated', async (state) => {
    const db = await handle!.pool.getConnection();
    try {
      for (const table of tables) await db.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
      await db.query(`CREATE TABLE ${prefix}mcp_access_logs (id BIGINT PRIMARY KEY,
        host_id BIGINT NULL, method VARCHAR(64), name VARCHAR(128), success TINYINT,
        error_message TEXT NULL, engine VARCHAR(16), created_at VARCHAR(100))`);
      await db.query(`CREATE TABLE ${prefix}admin_events (id BIGINT AUTO_INCREMENT PRIMARY KEY,
        type VARCHAR(64), host_id BIGINT NULL, payload JSON, created_at VARCHAR(100))`);
      await db.query(`CREATE TABLE ${prefix}logs (id BIGINT PRIMARY KEY, action VARCHAR(64))`);
      await db.query(`INSERT INTO ${prefix}logs VALUES (1,'skill.retrieve'),(2,'agent_message.queued'),(3,'auth.store'),
        (4,'admin.toast'),(5,'cron.update_reported')`);
      await db.query(`CREATE TABLE ${prefix}versions (name VARCHAR(100) PRIMARY KEY, version TEXT)`);
      await db.query(`INSERT INTO ${prefix}mcp_access_logs VALUES
        (1,7,'secret.read','secret_get:deploy.ssh',1,NULL,'codex','2026-10-23T10:00:00Z'),
        (2,7,'secret.read','secret_get:missing',0,'not_found','claude','2026-10-23T10:00:01Z'),
        (3,7,'tools/call','skill_list',1,NULL,'grok','2026-10-23T10:00:02Z')`);
      await db.query(`INSERT INTO ${prefix}versions VALUES ('log_retention_enabled','1'),('keep','1')`);
      let migration = await readFile(new URL('../../src/db/migrations/0092_remove_mcp_access_logs.sql', import.meta.url), 'utf8');
      migration = migration.replace(/\b(mcp_access_logs_retired|mcp_access_logs|admin_events|versions|logs)\b/g,
        (table) => prefix + table);
      if (state === 'copied_before_interruption') {
        await db.query(`RENAME TABLE ${prefix}mcp_access_logs TO ${prefix}mcp_access_logs_retired`);
        await db.query(`INSERT INTO ${prefix}admin_events (type,host_id,payload,created_at)
          VALUES ('secret.read',7,JSON_OBJECT('slug','deploy.ssh','success',1,'error_code',NULL,
            'engine','codex','legacy_mcp_log_id',1),'2026-10-23T10:00:00Z')`);
      }
      for (let run = 0; run < 2; run++) {
        for (const statement of splitSqlStatements(migration)) {
          await db.query(statement);
          if (statement.includes('EXECUTE mcp_logs_freeze_stmt')) {
            // Old application instances cannot successfully audit a credential
            // read between copying the stable source and dropping it.
            await expect(db.query(`INSERT INTO ${prefix}mcp_access_logs (id) VALUES (4)`))
              .rejects.toMatchObject({ code: 'ER_NO_SUCH_TABLE' });
          }
        }
        const [events] = await db.query<RowDataPacket[]>(`SELECT type, host_id, payload FROM ${prefix}admin_events ORDER BY id`);
        expect(events).toHaveLength(2);
        const details = events.map(row => typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload);
        expect(details).toMatchObject([
          { slug: 'deploy.ssh', success: 1, error_code: null, engine: 'codex', legacy_mcp_log_id: 1 },
          { slug: 'missing', success: 0, error_code: 'not_found', engine: 'claude', legacy_mcp_log_id: 2 },
        ]);
        const [source] = await db.query<RowDataPacket[]>(`SHOW TABLES LIKE '${prefix}mcp_access_logs'`);
        expect(source).toHaveLength(0);
        const [retired] = await db.query<RowDataPacket[]>(`SHOW TABLES LIKE '${prefix}mcp_access_logs_retired'`);
        expect(retired).toHaveLength(0);
        const [settings] = await db.query<RowDataPacket[]>(`SELECT name FROM ${prefix}versions`);
        expect(settings.map(row => row.name)).toEqual(['keep']);
        const [remaining] = await db.query<RowDataPacket[]>(`SELECT action FROM ${prefix}logs`);
        expect(remaining.map(row => row.action)).toEqual(['auth.store', 'cron.update_reported']);
      }
    } finally { db.release(); }
  });
});

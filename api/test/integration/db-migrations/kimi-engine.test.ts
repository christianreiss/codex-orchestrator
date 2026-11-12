import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { getTestDb } from '../../helpers/test-db.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Kimi engine migration against a pre-Kimi schema', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('adds host state and owner/usage tables, seeds a disabled gateway, and preserves pins on retry', async () => {
    const name = `kimi_migration_${randomBytes(6).toString('hex')}`;
    const conn = await handle!.pool.getConnection();
    const [current] = await conn.query<RowDataPacket[]>('SELECT DATABASE() AS name');
    const previous = current[0]!.name as string;
    try {
      await conn.query(`CREATE DATABASE \`${name}\``);
      await conn.query(`USE \`${name}\``);
      await conn.query('CREATE TABLE hosts (id BIGINT UNSIGNED PRIMARY KEY)');
      await conn.query(
        'CREATE TABLE versions (name VARCHAR(191) PRIMARY KEY, version LONGTEXT NOT NULL, updated_at VARCHAR(100) NOT NULL)',
      );
      const statements = splitSqlStatements(
        await readFile(new URL('../../../src/db/migrations/0130_kimi_engine.sql', import.meta.url), 'utf8'),
      );
      for (const statement of statements) await conn.query(statement);
      const [seeds] = await conn.query<RowDataPacket[]>('SELECT name, version FROM versions ORDER BY name');
      expect(seeds).toEqual([
        { name: 'api_surface_backend_kimi', version: 'kimi' },
        { name: 'kimi_api_disabled', version: '1' },
      ]);
      await conn.query("UPDATE versions SET version = '0' WHERE name = 'kimi_api_disabled'");
      await conn.query("INSERT INTO hosts (id, kimi_client_version_override) VALUES (1, '2.5.4')");
      for (const statement of statements) await conn.query(statement);
      const [columns] = await conn.query<RowDataPacket[]>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name LIKE 'kimi_%'",
      );
      expect(columns).toHaveLength(7);
      const [pins] = await conn.query<RowDataPacket[]>(
        'SELECT kimi_client_version_override FROM hosts WHERE id = 1',
      );
      expect(pins[0]!.kimi_client_version_override).toBe('2.5.4');
      const [flags] = await conn.query<RowDataPacket[]>(
        "SELECT version FROM versions WHERE name='kimi_api_disabled'",
      );
      expect(flags[0]!.version).toBe('0');
      for (const table of ['kimi_auth_refresh_state', 'kimi_usage_snapshots']) {
        const [rows] = await conn.query<RowDataPacket[]>(
          'SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?',
          [table],
        );
        expect(rows).toHaveLength(1);
      }
    } finally {
      await conn.query(`USE \`${previous}\``);
      await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
      conn.release();
    }
  });
});

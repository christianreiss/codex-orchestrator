import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { loadMigrations } from '../../../src/db/migrator.js';
import { getTestDb } from '../../helpers/test-db.js';
const handle = await getTestDb();
describe.skipIf(!handle)('orphaned launch-name slot migration', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('releases only slots whose session and lease are gone, and is idempotent', async () => {
    const connection = await handle!.pool.getConnection(),
      name = 'name_slots_' + randomUUID().replaceAll('-', '');
    const [current] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS name');
    try {
      await connection.query('CREATE DATABASE ??', [name]);
      await connection.query('USE ??', [name]);
      await connection.query(
        'CREATE TABLE agent_name_pool (name_key VARCHAR(64) NOT NULL PRIMARY KEY, current_session_id CHAR(36) NULL) COLLATE utf8mb4_unicode_ci',
      );
      await connection.query(
        'CREATE TABLE agent_name_leases (id INT AUTO_INCREMENT PRIMARY KEY, session_id CHAR(36) NOT NULL, name_key VARCHAR(64) NOT NULL) COLLATE utf8mb4_unicode_ci',
      );
      await connection.query(
        'CREATE TABLE agent_sessions (id CHAR(36) NOT NULL PRIMARY KEY) COLLATE utf8mb4_unicode_ci',
      );
      const orphan = randomUUID(),
        withLease = randomUUID(),
        liveNoLease = randomUUID();
      await connection.query('INSERT INTO agent_name_pool(name_key,current_session_id) VALUES ?', [
        [
          ['orphan', orphan],
          ['leased', withLease],
          ['live', liveNoLease],
          ['free', null],
        ],
      ]);
      await connection.query('INSERT INTO agent_name_leases(session_id,name_key) VALUES (?,?)', [
        withLease,
        'leased',
      ]);
      await connection.query('INSERT INTO agent_sessions(id) VALUES (?)', [liveNoLease]);
      const migration = (await loadMigrations()).find((m) => m.version === '0112')!;
      expect(migration).toBeDefined();
      for (let run = 0; run < 2; run++) {
        for (const statement of migration.statements) await connection.query(statement);
        const [rows] = await connection.query<RowDataPacket[]>(
          'SELECT name_key, current_session_id FROM agent_name_pool ORDER BY name_key',
        );
        expect(Object.fromEntries(rows.map((r) => [r.name_key, r.current_session_id]))).toEqual({
          orphan: null,
          leased: withLease,
          live: liveNoLease,
          free: null,
        });
      }
    } finally {
      await connection.query('USE ??', [current[0]!.name]);
      await connection.query('DROP DATABASE IF EXISTS ??', [name]);
      connection.release();
    }
  });
});

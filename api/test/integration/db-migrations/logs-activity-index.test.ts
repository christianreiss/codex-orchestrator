import { afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { loadMigrations } from '../../../src/db/migrator.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb();

describe.skipIf(!handle)('logs activity covering index migration', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });

  it('upgrades an existing logs table and is safe to apply twice', async () => {
    const connection = await handle!.pool.getConnection();
    try {
      const [existing] = await connection.query<RowDataPacket[]>(
        "SHOW INDEX FROM logs WHERE Key_name = 'idx_logs_action_created_host'",
      );
      // The fresh-install baseline must carry the same covering index.
      expect(existing.map((row) => row.Column_name)).toEqual(['action', 'created_at', 'host_id']);
      const migration = (await loadMigrations()).find((file) => file.version === '0063')!;
      expect(migration).toBeDefined();
      await connection.query('ALTER TABLE logs DROP INDEX idx_logs_action_created_host');
      for (let run = 0; run < 2; run++) {
        for (const statement of migration.statements) await connection.query(statement);
        const [columns] = await connection.query<RowDataPacket[]>(
          "SHOW INDEX FROM logs WHERE Key_name = 'idx_logs_action_created_host'",
        );
        expect(columns.map((row) => row.Column_name)).toEqual(['action', 'created_at', 'host_id']);
        expect(columns.every((row) => row.Sub_part === null && row.Non_unique === 1)).toBe(true);
      }
    } finally {
      connection.release();
    }
  });
});

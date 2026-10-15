import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { loadMigrations } from '../../../src/db/migrator.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb();
describe.skipIf(!handle)('retired call migration', () => {
  afterAll(async () => { await handle?.pool.end(); });
  it('removes legacy PINs twice, retires the Skill, and preserves conversations', async () => {
    const connection = await handle!.pool.getConnection();
    const conversationId = randomUUID();
    try {
      const migrations = await loadMigrations();
      for (const statement of migrations.find((m) => m.version === '0020')!.statements) {
        await connection.query(statement);
      }
      await connection.query(`INSERT INTO skills (slug, sha256, manifest, created_at, updated_at)
        VALUES ('call', ?, 'retired fixture', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z')
        ON DUPLICATE KEY UPDATE deleted_at = NULL`, ['0'.repeat(64)]);
      await connection.query(`INSERT INTO agent_bus_conversations
        (id, address_a_id, address_b_id, created_by_address_id, next_sequence, status, last_activity_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 'open', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z')`,
        [conversationId, randomUUID(), randomUUID(), randomUUID()]);
      const removal = migrations.find((m) => m.version === '0070')!;
      expect(removal).toBeDefined();
      for (let run = 0; run < 2; run++) {
        for (const statement of removal.statements) await connection.query(statement);
        const [columns] = await connection.query<RowDataPacket[]>(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_bus_addresses'
            AND COLUMN_NAME IN ('call_pin', 'call_pin_expires_at')`);
        expect(columns).toHaveLength(0);
        const [skill] = await connection.query<RowDataPacket[]>("SELECT deleted_at FROM skills WHERE slug = 'call'");
        expect(skill[0]?.deleted_at).toBeTruthy();
        const [history] = await connection.query<RowDataPacket[]>('SELECT status FROM agent_bus_conversations WHERE id = ?', [conversationId]);
        expect(history[0]?.status).toBe('open');
      }
    } finally {
      await connection.query('DELETE FROM agent_bus_conversations WHERE id = ?', [conversationId]);
      connection.release();
    }
  });
});

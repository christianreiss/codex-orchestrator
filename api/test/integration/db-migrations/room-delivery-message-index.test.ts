import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { loadMigrations } from '../../../src/db/migrator.js';
import { getTestDb } from '../../helpers/test-db.js';
const handle = await getTestDb();
describe.skipIf(!handle)('room message lookup index migration', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('upgrades an existing table idempotently and serves an indexed lookup', async () => {
    const connection = await handle!.pool.getConnection(),
      name = 'room_index_' + randomUUID().replaceAll('-', '');
    const [current] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS name');
    try {
      await connection.query('CREATE DATABASE ??', [name]);
      await connection.query('USE ??', [name]);
      await connection.query(
        'CREATE TABLE agent_room_deliveries (event_id CHAR(36) NOT NULL,address_id CHAR(36) NOT NULL,message_id CHAR(36),UNIQUE KEY uq_room_delivery(event_id,address_id))',
      );
      const migration = (await loadMigrations()).find((m) => m.version === '0104')!;
      expect(migration).toBeDefined();
      const target = randomUUID();
      const rows = Array.from({ length: 500 }, (_, i) => [
        randomUUID(),
        randomUUID(),
        i === 250 ? target : randomUUID(),
      ]);
      await connection.query('INSERT INTO agent_room_deliveries(event_id,address_id,message_id) VALUES ?', [
        rows,
      ]);
      for (let run = 0; run < 2; run++) {
        for (const statement of migration.statements) await connection.query(statement);
        const [indexes] = await connection.query<RowDataPacket[]>(
          "SHOW INDEX FROM agent_room_deliveries WHERE Key_name='idx_room_delivery_message'",
        );
        expect(indexes.map((r) => r.Column_name)).toEqual(['message_id']);
        expect(indexes[0]?.Non_unique).toBe(1);
      }
      const [plan] = await connection.query<RowDataPacket[]>(
        'EXPLAIN SELECT event_id FROM agent_room_deliveries WHERE message_id=?',
        [target],
      );
      expect(plan[0]?.key).toBe('idx_room_delivery_message');
      expect(plan[0]?.type).toBe('ref');
      const [count] = await connection.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM agent_room_deliveries',
      );
      expect(Number(count[0]?.n)).toBe(500);
    } finally {
      await connection.query('USE ??', [current[0]!.name]);
      await connection.query('DROP DATABASE IF EXISTS ??', [name]);
      connection.release();
    }
  });
});

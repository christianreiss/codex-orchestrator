import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { readDbConfig } from '../../helpers/test-db.js';

const config = readDbConfig();
describe.skipIf(!config)('durable delivery timing migration', () => {
  it('is idempotent, preserves old messages and persists the sender choice', async () => {
    const pool = mysql.createPool({ ...config!, connectionLimit: 1 }),
      connection = await pool.getConnection();
    const database = 'timing_migration_' + randomUUID().replaceAll('-', '');
    const [current] = await connection.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name');
    const previous = String(current[0]!.name);
    try {
      await connection.query(`CREATE DATABASE ${database}`);
      await connection.query(`USE ${database}`);
      await connection.query('CREATE TABLE agent_bus_messages (id INT PRIMARY KEY)');
      await connection.query('INSERT INTO agent_bus_messages(id) VALUES (1)');
      const migration = await readFile(
        new URL('../../../src/db/migrations/0105_agent_message_delivery_timing.sql', import.meta.url),
        'utf8',
      );
      for (let replay = 0; replay < 2; replay++)
        for (const statement of migration.split(';').filter((part) => part.trim()))
          await connection.query(statement);
      await connection.query("INSERT INTO agent_bus_messages(id,delivery_timing) VALUES (2,'immediate')");
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT id,delivery_timing FROM agent_bus_messages ORDER BY id',
      );
      expect(rows.map((row) => [row.id, row.delivery_timing])).toEqual([
        [1, 'after_turn'],
        [2, 'immediate'],
      ]);
      const [columns] = await connection.query<mysql.RowDataPacket[]>(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_messages' AND COLUMN_NAME='delivery_timing'",
      );
      expect(columns).toHaveLength(1);
    } finally {
      await connection.query(`USE ${previous}`);
      await connection.query(`DROP DATABASE IF EXISTS ${database}`);
      connection.release();
      await pool.end();
    }
  });
});

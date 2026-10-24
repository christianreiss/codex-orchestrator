import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { getTestDb } from '../../helpers/test-db.js';
import { readRetentionClock } from '../../../src/services/server-retention/deadlines.js';
import { SERVER_RETENTION_SECONDS } from '../../../src/services/server-retention/guards.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';

const handle = await getTestDb();
describe.skipIf(!handle)('retention clocks across legacy timestamp collations', () => {
  afterAll(async () => { await handle?.pool.end(); });
  it.each([
    ['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'],
    ['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci'],
  ])('combines %s and %s without losing retention delays or guard deadlines', async (first, second) => {
    const connection = await handle!.pool.getConnection();
    const database='retention_collation_'+randomUUID().replaceAll('-','');
    const [current] = await connection.query<import('mysql2/promise').RowDataPacket[]>('SELECT DATABASE() AS name');
    const originalDatabase=String(current[0]!.name);
    const now = Date.parse('2026-10-24T12:00:00.000Z'), delay = SERVER_RETENTION_SECONDS * 1000;
    const stamp = (offset: number) => new Date(now - delay + offset).toISOString();
    try {
      // MySQL cannot reopen one TEMPORARY table twice in a UNION; isolate all
      // fixture tables in a fresh private database instead of changing shared DDL.
      await connection.query(`CREATE DATABASE \`${database}\``);
      await connection.query(`USE \`${database}\``);
      await connection.query(`CREATE TABLE chatty_sessions (updated_at VARCHAR(100)) CHARACTER SET utf8mb4 COLLATE ${first}`);
      await connection.query(`CREATE TABLE chatty_runs (updated_at VARCHAR(100),lease_until VARCHAR(100)) CHARACTER SET utf8mb4 COLLATE ${second}`);
      await connection.query(`CREATE TABLE chatty_events (created_at VARCHAR(100)) CHARACTER SET utf8mb4 COLLATE ${first}`);
      await connection.query(`CREATE TABLE agent_sessions (heartbeat_at VARCHAR(100)) CHARACTER SET utf8mb4 COLLATE ${second}`);
      await connection.query(`CREATE TABLE agent_bus_addresses (last_seen_at VARCHAR(100)) CHARACTER SET utf8mb4 COLLATE ${first}`);
      await connection.query('INSERT INTO chatty_sessions VALUES (?)', [stamp(-1)]);
      await connection.query('INSERT INTO chatty_runs VALUES (?,?)', [stamp(10000), stamp(20000)]);
      await connection.query('INSERT INTO chatty_events VALUES (?)', [stamp(30000)]);
      await connection.query('INSERT INTO agent_sessions VALUES (?)', [stamp(5000)]);
      await connection.query('INSERT INTO agent_bus_addresses VALUES (?)', [stamp(7000)]);
      await expect(connection.query(`SELECT MIN(CASE WHEN updated_at > ? THEN updated_at ELSE NULL END) AS next_stamp FROM chatty_sessions
        UNION ALL SELECT MIN(CASE WHEN updated_at > ? THEN updated_at ELSE NULL END) FROM chatty_runs`, [stamp(0),stamp(0)]))
        .rejects.toMatchObject({code:'ER_CANT_AGGREGATE_NCOLLATIONS'});
      const tx = drizzle(connection) as unknown as PersistenceTransaction;
      expect(await readRetentionClock(tx,'chatty',now)).toEqual({past:true,next:now+5000});
      await connection.query('DELETE FROM chatty_sessions');
      // Guards schedule rechecks only for existing past candidates; the delay is
      // added to the actual future history stamp, not to the observation time.
      expect(await readRetentionClock(tx,'chatty',now)).toEqual({past:false,next:now+10000});
      expect(await readRetentionClock(tx,'chatty',now+12000)).toEqual({past:true,next:now+20000});
      await connection.query('DELETE FROM chatty_runs');
      await connection.query('DELETE FROM chatty_events');
      expect(await readRetentionClock(tx,'chatty',now)).toEqual({past:false,next:null});
    } finally {
      await connection.query(`USE \`${originalDatabase.replaceAll('`','``')}\``);
      await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
      connection.release();
    }
  });
});

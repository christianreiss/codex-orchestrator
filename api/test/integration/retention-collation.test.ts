import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { describe, it, expect, afterAll } from 'vitest';
import { protectedSession, addressActiveSince } from '../../src/services/server-retention/guards.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
const prefix = 'feedback_retention_';
const tables = ['agent_sessions', 'agent_bus_addresses', 'agent_schedules', 'agent_watchdogs',
  'agent_reboot_handoffs', 'agent_role_proposals', 'agent_bus_messages', 'agent_messages', 'agent_resource_claims'];
describe.skipIf(!handle)('mixed UUID collations in retention guards', () => {
  afterAll(async () => { await handle?.pool.end(); });
  it('retains pinned sessions and recently active addresses across legacy/new table defaults', async () => {
    const connection = await handle!.pool.getConnection();
    const id = randomUUID(), address = randomUUID();
    try {
      for (const table of tables) {
        await connection.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
        await connection.query(`CREATE TABLE ${prefix}${table} (
          id CHAR(36), agent_bus_address_id CHAR(36), session_id CHAR(36), target_address_id CHAR(36),
          address_id CHAR(36), old_session_id CHAR(36), new_session_id CHAR(36), author_address_id CHAR(36),
          reviewer_address_id CHAR(36), sender_address_id CHAR(36), status VARCHAR(32), deleted_at VARCHAR(100),
          last_seen_at VARCHAR(100), heartbeat_at VARCHAR(100)) CHARACTER SET utf8mb4 COLLATE ${table === 'agent_sessions' ? 'utf8mb4_unicode_ci' : 'utf8mb4_0900_ai_ci'}`);
      }
      await connection.query(`INSERT INTO ${prefix}agent_sessions (id, agent_bus_address_id, heartbeat_at) VALUES (?, ?, '2026-10-24T10:00:00Z')`, [id, address]);
      await connection.query(`INSERT INTO ${prefix}agent_bus_addresses (id) VALUES (?)`, [address]);
      await connection.query(`INSERT INTO ${prefix}agent_resource_claims (id, session_id, status) VALUES (?, ?, 'active')`, [randomUUID(), id]);
      // This fixture really reproduces the old implicit-equality failure.
      await expect(connection.query(`SELECT c.id FROM ${prefix}agent_resource_claims c JOIN ${prefix}agent_sessions s ON c.session_id=s.id`))
        .rejects.toMatchObject({ code: 'ER_CANT_AGGREGATE_2COLLATIONS' });
      // The real claim table calls this field state.
      await connection.query(`ALTER TABLE ${prefix}agent_resource_claims CHANGE status state VARCHAR(32)`);
      const query = new MySqlDialect().sqlToQuery(sql`SELECT s.id FROM agent_sessions s WHERE ${protectedSession(sql`s.id`, sql`s.agent_bus_address_id`)}`);
      let text = query.sql;
      for (const table of tables) text = text.replace(new RegExp(`\\b${table}\\b`, 'g'), prefix + table);
      const [pinned] = await connection.query(text, query.params);
      expect(pinned).toEqual([{ id }]);
      await connection.query(`DELETE FROM ${prefix}agent_resource_claims`);
      const [unprotected] = await connection.query(text, query.params);
      expect(unprotected).toEqual([]);
      const active = new MySqlDialect().sqlToQuery(sql`SELECT a.id FROM agent_bus_addresses a WHERE ${addressActiveSince(sql`a.id`, '2026-10-23T10:00:00Z')}`);
      let activeText = active.sql;
      for (const table of tables) activeText = activeText.replace(new RegExp(`\\b${table}\\b`, 'g'), prefix + table);
      const [recent] = await connection.query(activeText, active.params);
      expect(recent).toEqual([{ id: address }]);
    } finally {
      for (const table of tables) await connection.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
      connection.release();
    }
  });
});

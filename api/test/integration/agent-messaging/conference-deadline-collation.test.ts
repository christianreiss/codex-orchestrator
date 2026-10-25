import { randomUUID } from 'node:crypto';
import { describe, expect, it, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import * as schema from '../../../src/db/schema.js';
import { conferenceAdmissionOpenSql } from '../../../src/services/agent-messaging/conference-protocol.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb();
describe.skipIf(!handle)('conference admission across deployed mixed ID collations', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('fences room questions and preserves independent work and accepted results', async () => {
    const connection = await handle!.pool.getConnection();
    const database = 'conference_deadline_' + randomUUID().replaceAll('-', '');
    try {
      await connection.query(`CREATE DATABASE ${database}`);
      await connection.query(`USE ${database}`);
      await connection.query(`CREATE TABLE agent_bus_messages (
        id CHAR(36) COLLATE utf8mb4_unicode_ci PRIMARY KEY,
        conversation_id CHAR(36) COLLATE utf8mb4_unicode_ci,
        sender_address_id CHAR(36) COLLATE utf8mb4_unicode_ci,
        target_address_id CHAR(36) COLLATE utf8mb4_unicode_ci,
        reply_to_message_id CHAR(36) COLLATE utf8mb4_unicode_ci,
        kind VARCHAR(30), work_kind VARCHAR(30), accepted_at VARCHAR(100)) CHARACTER SET utf8mb4`);
      await connection.query(
        `CREATE TABLE agent_bus_conferences (id CHAR(36) COLLATE utf8mb4_unicode_ci PRIMARY KEY, deadline_at VARCHAR(100)) CHARACTER SET utf8mb4`,
      );
      await connection.query(
        `CREATE TABLE agent_bus_conference_members (conversation_id CHAR(36) COLLATE utf8mb4_unicode_ci, conference_id CHAR(36) COLLATE utf8mb4_unicode_ci, KEY(conversation_id)) CHARACTER SET utf8mb4`,
      );
      await connection.query(
        `CREATE TABLE agent_room_events (id CHAR(36) COLLATE utf8mb4_0900_ai_ci PRIMARY KEY, room_id CHAR(36) COLLATE utf8mb4_0900_ai_ci) CHARACTER SET utf8mb4`,
      );
      await connection.query(
        `CREATE TABLE agent_room_deliveries (event_id CHAR(36) COLLATE utf8mb4_0900_ai_ci, message_id CHAR(36) COLLATE utf8mb4_unicode_ci, KEY(message_id)) CHARACTER SET utf8mb4`,
      );
      const db = drizzle(connection, { schema, mode: 'default' });
      for (const engine of ['codex', 'claude', 'grok']) {
        const questionId = randomUUID(),
          roomId = randomUUID(),
          eventId = randomUUID(),
          directId = randomUUID();
        const parentId = randomUUID(),
          replyId = randomUUID(),
          conversationId = randomUUID();
        const senderId = randomUUID(),
          targetId = randomUUID();
        await connection.execute('INSERT INTO agent_bus_conferences VALUES (?, ?)', [
          roomId,
          '2000-01-01T00:00:00Z',
        ]);
        await connection.execute('INSERT INTO agent_room_events VALUES (?, ?)', [eventId, roomId]);
        await connection.execute('INSERT INTO agent_room_deliveries VALUES (?, ?)', [eventId, questionId]);
        for (const [id, conv, sender, target, parent, kind, work, accepted] of [
          [questionId, randomUUID(), senderId, targetId, null, 'message', null, null],
          [directId, randomUUID(), senderId, targetId, null, 'task', 'task', null],
          [parentId, conversationId, senderId, targetId, null, 'task', 'task', '2026-01-01T00:00:00Z'],
          [replyId, conversationId, targetId, senderId, parentId, 'reply', null, null],
        ] as Array<[string, string, string, string, string | null, string, string | null, string | null]>)
          await connection.execute('INSERT INTO agent_bus_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            id,
            conv,
            sender,
            target,
            parent,
            kind,
            work,
            accepted,
          ]);
        await connection.execute('INSERT INTO agent_bus_conference_members VALUES (?, ?)', [
          conversationId,
          roomId,
        ]);
        const read = async (id: string) =>
          (
            await db
              .select({ open: conferenceAdmissionOpenSql('2026-10-25T12:00:00Z') })
              .from(schema.agentBusMessages)
              .where(eq(schema.agentBusMessages.id, id))
          )[0]!.open;
        expect(Number(await read(questionId)), `${engine}: expired private room question`).toBe(0);
        expect(Number(await read(directId)), `${engine}: independent work`).toBe(1);
        expect(Number(await read(parentId)), `${engine}: expired fresh task`).toBe(0);
        expect(Number(await read(replyId)), `${engine}: accepted task result`).toBe(1);
      }
    } finally {
      await connection.query(`DROP DATABASE IF EXISTS ${database}`);
      connection.release();
    }
  });
});

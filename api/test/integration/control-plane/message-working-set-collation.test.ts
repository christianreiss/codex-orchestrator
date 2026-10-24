import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { getTestDb } from '../../helpers/test-db.js';
import { agentBusMessages } from '../../../src/db/schema.js';
import { workingSetPredicate } from '../../../src/control-plane/state/catalog.js';

const handle = await getTestDb();
const terminal = "('completed','delivered','digested','dead','expired','canceled','superseded')";
const system = '00000000-0000-4000-8000-000000000001';
describe.skipIf(!handle)('materialized message working set across legacy collations', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it.each([
    ['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'],
    ['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci'],
  ])('preserves every dependency with %s / %s', async (first, second) => {
    const connection = await handle!.pool.getConnection();
    const database = 'message_set_' + randomUUID().replaceAll('-', '');
    const [current] =
      await connection.query<import('mysql2/promise').RowDataPacket[]>('SELECT DATABASE() AS name');
    const original = String(current[0]!.name);
    try {
      await connection.query(`CREATE DATABASE \`${database}\``);
      await connection.query(`USE \`${database}\``);
      for (const [name, columns, collation] of [
        [
          'agent_bus_messages',
          'id VARCHAR(36) PRIMARY KEY,status VARCHAR(40),expired_at VARCHAR(40),digest_id VARCHAR(36),reply_to_message_id VARCHAR(36),presence_notice_key VARCHAR(100),target_session_id VARCHAR(36),sender_address_id VARCHAR(36)',
          first,
        ],
        ['agent_schedule_runs', 'message_id VARCHAR(36),status VARCHAR(40)', second],
        ['agent_watchdogs', 'message_id VARCHAR(36),status VARCHAR(40)', second],
        ['agent_sessions', 'id VARCHAR(36) PRIMARY KEY,ended_at VARCHAR(40)', second],
        ['agent_room_deliveries', 'message_id VARCHAR(36),event_id VARCHAR(36)', second],
        ['agent_room_events', 'id VARCHAR(36) PRIMARY KEY,room_id VARCHAR(36)', first],
        ['agent_bus_conferences', 'id VARCHAR(36) PRIMARY KEY,status VARCHAR(40)', second],
      ])
        await connection.query(
          `CREATE TABLE ${name} (${columns}) CHARACTER SET utf8mb4 COLLATE ${collation}`,
        );
      const ids = new Map<string, string>();
      const id = (name: string) => {
        if (!ids.has(name)) ids.set(name, randomUUID());
        return ids.get(name)!;
      };
      const add = async (name: string, status: string | null, values: Record<string, string | null> = {}) => {
        const row = { id: id(name), status, ...values };
        await connection.query(
          `INSERT INTO agent_bus_messages (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
            .map(() => '?')
            .join(',')})`,
          Object.values(row),
        );
      };
      await add('plain-terminal', 'completed');
      await add('unknown-status', null);
      await add('ambiguous', 'ambiguous');
      await add('recent-expired', 'expired', { expired_at: new Date().toISOString() });
      await add('old-expired', 'expired', { expired_at: '2000-01-01T00:00:00.000Z' });
      await add('digest-parent', 'expired');
      await add('digest-child', 'batched', { digest_id: id('digest-parent') });
      await add('non-batched-parent', 'completed');
      await add('non-batched-child', 'completed', { digest_id: id('non-batched-parent') });
      await add('reply-parent', 'completed');
      await add('reply', 'queued', { reply_to_message_id: id('reply-parent') });
      await add('terminal-reply-parent', 'completed');
      await add('terminal-reply', 'completed', { reply_to_message_id: id('terminal-reply-parent') });
      await add('null-reply-parent', 'completed');
      await add('null-reply', null, { reply_to_message_id: id('null-reply-parent') });
      for (const [table, statuses] of [
        [
          'agent_schedule_runs',
          ['waiting', 'queued', 'leased', 'accepted', 'recovering', 'capacity_wait', 'completed', null],
        ],
        ['agent_watchdogs', ['watching', 'recovering', 'capacity_wait', 'completed', null]],
      ] as const)
        for (const status of statuses) {
          const name = `${table}-${status}`;
          await add(name, 'completed');
          await connection.query(`INSERT INTO ${table} VALUES (?,?),(NULL,?)`, [id(name), status, status]);
        }
      await connection.query('INSERT INTO agent_sessions VALUES (?,NULL),(?,NULL),(?,?)', [
        id('recipient'),
        id('sender'),
        id('ended'),
        '2026-01-01T00:00:00Z',
      ]);
      for (const [name, recipient, sender] of [
        ['notice-live', 'recipient', 'sender'],
        ['notice-ended-recipient', 'ended', 'sender'],
        ['notice-ended-sender', 'recipient', 'ended'],
        ['notice-missing', 'missing', 'sender'],
      ])
        await add(name!, 'completed', {
          presence_notice_key: `${id(recipient!)}:return`,
          target_session_id: id(sender!),
        });
      await add('notice-no-colon', 'completed', {
        presence_notice_key: id('recipient'),
        target_session_id: id('sender'),
      });
      await add('notice-null-target', 'completed', { presence_notice_key: `${id('recipient')}:return` });
      await connection.query('INSERT INTO agent_bus_conferences VALUES (?,?),(?,?),(?,NULL)', [
        id('open-room'),
        'active',
        id('closed-room'),
        'adjourned',
        id('null-room'),
      ]);
      for (const room of ['open-room', 'closed-room', 'null-room']) {
        await connection.query('INSERT INTO agent_room_events VALUES (?,?)', [id(`event-${room}`), id(room)]);
        for (const status of [
          'delivered',
          'superseded',
          'completed',
          'dead',
          'expired',
          'canceled',
          'ambiguous',
        ]) {
          const name = `conference-${room}-${status}`;
          await add(name, status, { sender_address_id: system });
          await connection.query('INSERT INTO agent_room_deliveries VALUES (?,?)', [
            id(name),
            id(`event-${room}`),
          ]);
        }
      }
      await add('conference-non-system', 'delivered', { sender_address_id: id('sender') });
      await connection.query('INSERT INTO agent_room_deliveries VALUES (?,?),(NULL,?),(?,NULL)', [
        id('conference-non-system'),
        id('event-open-room'),
        id('event-open-room'),
        id('plain-terminal'),
      ]);
      const old = `
        (m.status='expired' AND m.expired_at > ?)
        OR EXISTS (SELECT 1 FROM agent_bus_messages child WHERE BINARY child.digest_id=BINARY m.id AND child.status='batched')
        OR EXISTS (SELECT 1 FROM agent_bus_messages reply WHERE BINARY reply.reply_to_message_id=BINARY m.id AND reply.status NOT IN ${terminal})
        OR EXISTS (SELECT 1 FROM agent_schedule_runs r WHERE BINARY r.message_id=BINARY m.id AND r.status IN ('waiting','queued','leased','accepted','recovering','capacity_wait'))
        OR EXISTS (SELECT 1 FROM agent_watchdogs w WHERE BINARY w.message_id=BINARY m.id AND w.status IN ('watching','recovering','capacity_wait'))
        OR (m.presence_notice_key IS NOT NULL AND EXISTS (SELECT 1 FROM agent_sessions recipient WHERE BINARY recipient.id=BINARY SUBSTRING_INDEX(m.presence_notice_key,':',1) AND recipient.ended_at IS NULL) AND EXISTS (SELECT 1 FROM agent_sessions sender WHERE BINARY sender.id=BINARY m.target_session_id AND sender.ended_at IS NULL))
        OR m.status NOT IN ${terminal}
        OR (m.sender_address_id='${system}' AND m.status NOT IN ('completed','dead','expired','canceled','ambiguous') AND EXISTS (SELECT 1 FROM agent_room_deliveries d JOIN agent_room_events e ON BINARY e.id=BINARY d.event_id JOIN agent_bus_conferences c ON BINARY c.id=BINARY e.room_id WHERE BINARY d.message_id=BINARY m.id AND c.status<>'adjourned'))`;
      const [previous] = await connection.query<import('mysql2/promise').RowDataPacket[]>(
        `SELECT id FROM agent_bus_messages m WHERE ${old}`,
        [new Date(Date.now() - 30 * 60 * 1000).toISOString()],
      );
      const query = drizzle(connection)
        .select({ id: agentBusMessages.id })
        .from(agentBusMessages)
        .where(workingSetPredicate('agentBusMessages'));
      const next = await query;
      expect(next.map((row) => row.id).sort()).toEqual(previous.map((row) => String(row.id)).sort());
      expect(next.map((row) => row.id)).toEqual(
        expect.arrayContaining(
          [
            'digest-parent',
            'reply-parent',
            'notice-live',
            'notice-no-colon',
            'conference-open-room-delivered',
            'conference-open-room-superseded',
          ].map(id),
        ),
      );
      const compiled = query.toSQL();
      const [plan] = await connection.query<import('mysql2/promise').RowDataPacket[]>(
        `EXPLAIN ${compiled.sql}`,
        compiled.params,
      );
      // A dependent unique-key lookup into the materialized set is fine;
      // rescanning base relations per outer message is the regression.
      expect(
        plan.some(
          (row) =>
            String(row.select_type).startsWith('DEPENDENT') && !String(row.table).startsWith('<derived'),
        ),
      ).toBe(false);
      expect(plan.some((row) => row.select_type === 'DERIVED')).toBe(true);
    } finally {
      await connection.query(`USE \`${original.replaceAll('`', '``')}\``);
      await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
      connection.release();
    }
  });
});

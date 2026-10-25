import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AgentRoomChat } from '../../../../src/services/agent-room-chat/index.js';
import {
  agentBusGroups,
  agentBusPublications,
  agentBusMessages,
  agentRoomEvents,
} from '../../../../src/db/schema.js';
import { encrypt } from '../../../../src/security/secret-box.js';
import { createDbFake } from '../../../helpers/db-fake.js';
import { testKeyring } from '../../../helpers/test-keyring.js';
import type { Database } from '../../../../src/db/client.js';
import type { Env } from '../../../../src/env.js';
import type { AgentMessagingService } from '../../../../src/services/agent-messaging.js';

describe('group history follows immutable room identity', () => {
  for (const engine of ['codex', 'claude', 'grok']) {
    for (const [kind, publicationAt] of [
      ['old bound event', '2026-10-24T12:00:00.000Z'],
      ['unbound old publication', '2026-10-24T12:00:00.000Z'],
      ['unbound future publication', '2099-10-25T12:00:00.000Z'],
      ['unbound same-millisecond publication', '2026-10-25T12:00:00.000Z'],
    ] as const) {
      it(`${engine}: retains new room events and excludes ${kind} after slug reuse`, async () => {
        const keyring = testKeyring(),
          roomId = randomUUID(),
          previousRoomId = randomUUID();
        const publicationId = randomUUID(),
          messageId = randomUUID(),
          eventId = randomUUID();
        const createdAt = '2026-10-25T12:00:00.000Z';
        const privateText = 'private content from the previous group lifetime';
        const events = [
          {
            id: eventId,
            roomId,
            actor: 'agent:new-member',
            createdAt,
            bodyEnc: encrypt(
              JSON.stringify({ content: 'current group content', kind: 'publication' }),
              keyring,
            ),
          },
        ];
        if (kind === 'old bound event')
          events.push({
            id: publicationId,
            roomId: previousRoomId,
            actor: 'agent:old-member',
            createdAt: publicationAt,
            bodyEnc: encrypt(JSON.stringify({ content: privateText, kind: 'publication' }), keyring),
          });
        const db = createDbFake(
          new Map<unknown, Record<string, unknown>[]>([
            [agentBusGroups, [{ id: roomId, slug: 'reused', createdAt }]],
            [agentRoomEvents, events],
            [
              agentBusPublications,
              [
                {
                  id: publicationId,
                  topic: 'group:reused',
                  createdAt: publicationAt,
                  senderAddressId: randomUUID(),
                  receipts: { deliveries: [{ message_id: messageId }] },
                },
              ],
            ],
            [
              agentBusMessages,
              [{ id: messageId, contentEnc: encrypt(`PUBLICATION/1 old\n\n${privateText}`, keyring) }],
            ],
          ]),
        );
        const chat = new AgentRoomChat(
          db as unknown as Database,
          { DATA_ROOT: '/tmp' } as Env,
          keyring,
          {} as AgentMessagingService,
        );
        // Authorization is covered separately. Exercise the real history reader,
        // SQL predicates, encrypted bodies and pagination for an admitted member.
        const internal = chat as unknown as {
          run(actor: unknown, fn: (tx: unknown, session: null) => Promise<unknown>): Promise<unknown>;
        };
        vi.spyOn(internal, 'run').mockImplementation((_actor, fn) => fn(db, null));
        vi.spyOn(chat, 'room').mockResolvedValue({
          id: roomId,
          kind: 'group',
          members: [],
          title: 'New group',
          description: '',
          status: 'open',
          created_at: createdAt,
        });
        const result = await chat.read({ adminId: 1 }, { room_id: roomId });
        expect(result.events.map((event) => event.content)).toEqual(['current group content']);
        expect(result.events.map((event) => event.id)).toEqual([eventId]);
      });
    }
  }
});

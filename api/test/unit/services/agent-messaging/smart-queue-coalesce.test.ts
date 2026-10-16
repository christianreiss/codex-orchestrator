import { describe, expect, it } from 'vitest';
import { coalescedEventStats, coalescePendingRepeats, queuePolicy } from '../../../../src/services/agent-messaging/smart-queue.js';
import type { AgentMessagingDb } from '../../../../src/services/agent-messaging/types.js';

describe('send-time coalescing', () => {
  const now = '2026-10-16T06:11:12.000Z';

  it('inherits the replaced event count and earliest first event', () => {
    expect(coalescedEventStats([], now)).toEqual({ eventCount: 1, eventFirstAt: now, eventLastAt: now });
    expect(
      coalescedEventStats(
        [
          { eventCount: 2, eventFirstAt: '2026-10-16T06:09:00.000Z', createdAt: '2026-10-16T06:10:00.000Z' },
          { eventCount: 1, eventFirstAt: null, createdAt: '2026-10-16T06:10:21.000Z' },
        ],
        now,
      ),
    ).toEqual({ eventCount: 4, eventFirstAt: '2026-10-16T06:09:00.000Z', eventLastAt: now });
  });

  it('touches nothing without an explicit progress/notice key', async () => {
    const tx = new Proxy({}, {
      get: () => {
        throw new Error('db must not be used');
      },
    }) as unknown as AgentMessagingDb;
    for (const policy of [
      queuePolicy(undefined),
      queuePolicy({ delivery_class: 'progress' }),
      queuePolicy({ delivery_class: 'coordination' }),
    ])
      await expect(
        coalescePendingRepeats(tx, { messageId: 'm', senderAddressId: 's', targetAddressId: 't', policy, now }),
      ).resolves.toEqual([]);
  });
});

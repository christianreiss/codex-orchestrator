import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OwnerStateSnapshot, OwnerStateStore } from '../src/control-plane/state/store.js';
import {
  recordMessagingRowChange,
  recordAssistantResponse,
  type MessagingTotals,
} from '../src/control-plane/state/messaging-totals.js';
import type { StateSeed } from '../src/control-plane/state/catalog.js';
const epoch = randomUUID();
describe('historical messaging totals', () => {
  it('keeps cold historical counts across working-set eviction and applies exact durable deltas atomically', () => {
    const historical: MessagingTotals = {
      bus: [
        { sourceEngine: 'codex', targetEngine: 'claude', status: 'completed', count: 100 },
        { sourceEngine: 'codex', targetEngine: 'claude', status: 'queued', count: 1 },
      ],
      portal: [],
      responses: [],
    };
    const row = { id: randomUUID(), sourceEngine: 'codex', targetEngine: 'claude', status: 'queued' };
    const store = new OwnerStateStore(
        new OwnerStateSnapshot(
          { epoch, sequence: 0n },
          { agentBusMessages: [row] } as unknown as StateSeed,
          undefined,
          undefined,
          historical,
        ),
      ),
      before = store.snapshot(),
      draft = store.begin();
    recordMessagingRowChange(draft, 'agentBusMessages', row, { ...row, status: 'completed' });
    draft.upsert('agentBusMessages', { ...row, status: 'completed' } as never);
    draft.remove('agentBusMessages', row.id);
    expect(before.messagingTotals.bus.find((r) => r.status === 'queued')?.count).toBe(1);
    expect(store.snapshot()).toBe(before);
    store.publish(draft.seal({ epoch, sequence: 1n }));
    expect(store.snapshot().messages.size).toBe(0);
    expect(store.snapshot().messagingTotals.bus).toEqual([
      { sourceEngine: 'codex', targetEngine: 'claude', status: 'completed', count: 101 },
    ]);
    const retention = store.begin();
    retention.adjustMessagingTotals({
      bus: [{ sourceEngine: 'codex', targetEngine: 'claude', status: 'completed', count: -100 }],
    });
    store.publish(retention.seal({ epoch, sequence: 2n }));
    expect(store.snapshot().messagingTotals.bus[0]?.count).toBe(1);
    expect(before.messagingTotals.bus[0]?.count).toBe(100);
    expect(() =>
      store.begin().adjustMessagingTotals({
        bus: [{ sourceEngine: 'codex', targetEngine: 'claude', status: 'completed', count: -2 }],
      }),
    ).toThrow('Invalid historical');
  });
  it('counts portal responses only for bridge/engine assistant events and isolates engines', () => {
    const store = new OwnerStateStore(
        new OwnerStateSnapshot({ epoch, sequence: 0n }, {
          agentSessions: [{ id: 's', engine: 'grok' }],
        } as unknown as StateSeed),
      ),
      draft = store.begin();
    recordMessagingRowChange(draft, 'agentMessages', null, { sessionId: 's', status: 'queued' });
    recordMessagingRowChange(
      draft,
      'agentMessages',
      { sessionId: 's', status: 'queued' },
      { sessionId: 's', status: 'accepted' },
    );
    for (const event of [
      { eventType: 'assistant_message', source: 'bridge' },
      { eventType: 'assistant_message', source: 'engine' },
      { eventType: 'assistant_message', source: 'portal' },
      { eventType: 'user_message', source: 'bridge' },
    ])
      recordAssistantResponse(draft, { sessionId: 's', ...event });
    store.publish(draft.seal({ epoch, sequence: 1n }));
    expect(store.snapshot().messagingTotals).toEqual({
      bus: [],
      portal: [{ engine: 'grok', status: 'accepted', count: 1 }],
      responses: [{ engine: 'grok', count: 2 }],
    });
  });
});

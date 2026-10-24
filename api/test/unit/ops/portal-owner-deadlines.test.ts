import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OwnerStateSnapshot } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { portalObligations } from '../../../src/ops/portal-obligations.js';
const facts = {
  relayConnected: () => false,
  sessionConnected: () => false,
  receiverConnected: () => false,
  revision: () => 'connected',
  conferenceHasPendingDeliveries: () => false,
};
describe('connected host retention deadlines', () => {
  it('does not age a connected idle host into inactivity while preserving its actual expiry', () => {
    const snapshot = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      hosts: [
        {
          id: 1,
          createdAt: '2000-01-01T00:00:00.000Z',
          lastContactAt: null,
          apiCalls: 0,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    } as unknown as StateSeed);
    expect(
      portalObligations(snapshot, facts, 0, () => ({ connected: true, lastAt: Date.now() })).map(
        (row) => row.key,
      ),
    ).toEqual(['host:expiry:1']);
    const detachedAt = Date.now();
    const detached = portalObligations(snapshot, facts, 0, () => ({ connected: false, lastAt: detachedAt }));
    expect(detached.find((row) => row.key === 'host:inactive:1')?.dueAt).toBe(
      detachedAt + 30 * 86_400_000 + 1,
    );
    expect(detached.find((row) => row.key === 'host:provision:1')?.dueAt).toBe(detachedAt + 1_800_001);
  });
});

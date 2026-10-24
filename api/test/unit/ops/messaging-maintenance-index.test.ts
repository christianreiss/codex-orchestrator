import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OwnerStateSnapshot } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { messagingMaintenanceObligations } from '../../../src/ops/maintenance-obligations.js';

const stamp = '2026-10-24T10:00:00.000Z';
const facts = {
  relayConnected: () => false,
  sessionConnected: () => false,
  receiverConnected: () => false,
  revision: () => '1',
  conferenceHasPendingDeliveries: () => false,
};
function snapshot(messages: object[], extra: object = {}) {
  return new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
    agentBusMessages: messages.map((row) => ({ kind: 'message', expiresAt: stamp, updatedAt: stamp, leaseUntil: stamp, ...row })),
    ...extra,
  } as unknown as StateSeed);
}
describe('indexed messaging maintenance', () => {
  it('selects only actionable status buckets without traversing retained messages', () => {
    const state = snapshot(['queued', 'batched', 'leased', 'accepted', 'completed', 'dead', 'expired', 'canceled', 'ambiguous'].flatMap((status) => ['timed', 'connection'].map((ownershipMode) => ({ id: `${status}-${ownershipMode}`, status, ownershipMode }))));
    const all = vi.fn(() => { throw new Error('retained history traversed'); });
    const by = vi.fn(state.messages.by.bind(state.messages));
    const guarded = { messages: { all, by }, sessions: state.sessions, addresses: state.addresses, table: state.table.bind(state) } as unknown as OwnerStateSnapshot;
    expect(messagingMaintenanceObligations(guarded, facts).map((item) => item.key).sort()).toEqual([
      'message:expire:queued-timed', 'message:expire:queued-connection',
      'message:expire:batched-timed', 'message:expire:batched-connection',
      'message:expire:leased-timed', 'message:lease:leased-timed', 'message:accepted:accepted-timed',
    ].sort());
    expect(all).not.toHaveBeenCalled();
    expect(by.mock.calls).toEqual(['queued', 'batched', 'leased', 'accepted'].map((status) => ['status', status]));
  });
  it('retains timed accepted fallback deadline and excludes connection-owned expiry', () => {
    const state = snapshot([
      { id: 'old', status: 'accepted', ownershipMode: 'timed', leaseUntil: null },
      { id: 'new', status: 'accepted', ownershipMode: 'connection', leaseUntil: null },
      { id: 'lease', status: 'leased', ownershipMode: 'connection' },
    ]);
    expect(messagingMaintenanceObligations(state, facts)).toEqual([{ key: 'message:accepted:old', dueAt: Date.parse(stamp) + 86_400_000, revision: stamp }]);
  });
  it.each(['queued', 'batched', 'leased', 'accepted'])('preserves %s presence notice pruning for missing, ended and replaced bindings', (status) => {
    const state = snapshot(['missing', 'ended', 'replaced', 'live'].map((targetSessionId) => ({
      id: targetSessionId, kind: 'presence_notice', ownershipMode: 'connection', status, targetSessionId, targetAddressId: targetSessionId,
    })), {
      agentSessions: [{ id: 'ended', endedAt: stamp }, { id: 'replaced', endedAt: null }, { id: 'live', endedAt: null }],
      agentBusAddresses: [{ id: 'ended', currentSessionId: 'ended' }, { id: 'replaced', currentSessionId: 'other' }, { id: 'live', currentSessionId: 'live' }],
    });
    expect(messagingMaintenanceObligations(state, facts).filter((item) => item.key.startsWith('notice:')).map((item) => item.key).sort()).toEqual(['notice:ended', 'notice:missing', 'notice:replaced']);
  });
});

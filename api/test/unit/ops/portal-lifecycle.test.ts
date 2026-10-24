import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OwnerStateSnapshot, OwnerStateDraft } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { OwnerMutationContext } from '../../../src/control-plane/state/runtime.js';
import type { AgentSession } from '../../../src/db/schema.js';
import { stagePortalSessionFinish } from '../../../src/control-plane/state/portal-lifecycle.js';
import { testKeyring } from '../../helpers/test-keyring.js';

function fixture(extra: Record<string, unknown> = {}) {
  const session = {
    id: 'session',
    engine: 'codex',
    agentBusAddressId: 'address',
    upstreamSessionId: 'native',
    invocationKind: 'interactive',
    bindingGeneration: 4,
    heartbeatAt: '2026-10-24T00:00:00.000Z',
    endedAt: null,
    closeRequestedAt: null,
  } as AgentSession;
  const seed = {
    agentSessions: [session],
    agentBusAddresses: [
      {
        id: 'address',
        currentSessionId: 'session',
        bindingGeneration: 4,
        lastUpstreamSessionId: 'native',
        lastSeenAt: '2026-10-23T00:00:00.000Z',
      },
    ],
    agentMessages: [
      { id: 1, messageId: 'pending', sessionId: 'session', kind: 'message', status: 'queued' },
      { id: 2, messageId: 'accepted', sessionId: 'session', kind: 'message', status: 'accepted' },
    ],
    agentBusMessages: [
      {
        id: 'relay-result',
        targetAddressId: 'address',
        deliverySessionId: 'session',
        targetBindingGeneration: 4,
        status: 'accepted',
        relayGeneration: 1,
        leaseOwner: 'relay:r:1',
        leaseUntil: '2026-10-25T00:00:00.000Z',
      },
    ],
    ...extra,
  };
  const snapshot = new OwnerStateSnapshot(
    { epoch: randomUUID(), sequence: 0n },
    seed as unknown as StateSeed,
  );
  const draft = new OwnerStateDraft(snapshot);
  const writes: unknown[] = [];
  const context = {
    snapshot,
    draft,
    revision: { ...snapshot.revision, sequence: 1n },
    write: (fn: unknown) => {
      writes.push(fn);
    },
    effect: () => {},
  } as OwnerMutationContext;
  return { session, draft, context, writes };
}
describe('owner portal terminal parity', () => {
  it('fences the ended binding but preserves accepted effects and normal relay results', () => {
    const f = fixture(),
      now = '2026-10-24T12:00:00.000Z';
    expect(stagePortalSessionFinish(f.context, f.session, 'completed', now, now, testKeyring())).toBe(true);
    expect(f.draft.table('agentMessages').get(1)?.status).toBe('canceled');
    expect(f.draft.table('agentMessages').get(2)?.status).toBe('accepted');
    expect(f.draft.table('agentBusAddresses').get('address')).toMatchObject({
      currentSessionId: null,
      bindingGeneration: 5,
      readiness: 'resumable',
      lastSeenAt: f.session.heartbeatAt,
    });
    expect(f.draft.table('agentBusMessages').get('relay-result')).toMatchObject({
      status: 'accepted',
      targetBindingGeneration: 5,
    });
    expect(f.draft.table('agentSessions').get('session')?.bindingGeneration).toBe(5);
    expect(f.writes.length).toBeGreaterThan(0);
  });
  it('preserves final relay results for connection ownership with no timed lease', () => {
    const f = fixture({
      agentBusMessages: [
        {
          id: 'connection-result',
          targetAddressId: 'address',
          deliverySessionId: 'session',
          targetBindingGeneration: 4,
          status: 'accepted',
          relayGeneration: 1,
          leaseOwner: 'relay:r:1',
          leaseUntil: null,
          ownershipMode: 'connection',
          ownerInstanceId: 'communicator-instance',
          claimId: 'accepted-claim',
        },
      ],
    });
    expect(stagePortalSessionFinish(f.context, f.session, 'completed', 'later', 'now', testKeyring())).toBe(
      true,
    );
    expect(f.draft.table('agentBusMessages').get('connection-result')).toMatchObject({
      status: 'accepted',
      targetBindingGeneration: 5,
      claimId: 'accepted-claim',
      ownerInstanceId: 'communicator-instance',
      leaseUntil: null,
    });
  });
  it('retains exact leased offers when the channel ends because delivery may already have begun', () => {
    const f = fixture({
      agentMessages: [
        {
          id: 7,
          messageId: 'offered',
          sessionId: 'session',
          kind: 'message',
          status: 'leased',
          leaseOwner: 'exact-claim',
          leaseUntil: null,
          ownerInstanceId: 'instance',
          ownershipMode: 'connection',
        },
      ],
    });
    stagePortalSessionFinish(f.context, f.session, 'completed', 'later', 'now', testKeyring());
    expect(f.draft.table('agentMessages').get(7)).toMatchObject({
      status: 'leased',
      leaseOwner: 'exact-claim',
      leaseUntil: null,
      ownerInstanceId: 'instance',
    });
  });
  it('does not end an armed reboot lifecycle or cancel its work', () => {
    const f = fixture({ agentRebootHandoffs: [{ id: 'reboot', oldSessionId: 'session', status: 'armed' }] });
    expect(stagePortalSessionFinish(f.context, f.session, 'failed', 'later', 'now', testKeyring())).toBe(
      false,
    );
    expect(f.draft.table('agentMessages').get(1)?.status).toBe('queued');
    expect(f.writes).toEqual([]);
  });
});

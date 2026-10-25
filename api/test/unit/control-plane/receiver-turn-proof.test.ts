import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import { OwnerStateSnapshot } from '../../../src/control-plane/state/store.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { StateRow } from '../../../src/control-plane/state/catalog.js';
import {
  acceptOwnedClaudeTurnProof,
  ownedClaudeTurnIdle,
  type ReceiverTurnProof,
} from '../../../src/control-plane/state/receiver-turn-proof.js';

function fixture() {
  const id = randomUUID(),
    instance = randomUUID(),
    generation = randomUUID();
  let session = {
    id,
    hostId: 1,
    username: 'fixture',
    engine: 'claude',
    bindingGeneration: 1,
    upstreamSessionId: 'native',
    endedAt: null,
    activity: null,
    receiver: {
      generation,
      native_session_id: 'native',
      protocol: 'claude-channel-v1',
      failure: null,
      heartbeat_at: '2000-01-01T00:00:00.000Z',
      probes: { peer: {} },
    },
  } as unknown as StateRow<'agentSessions'>;
  const owner = { assertOwner() {} } as OwnerRuntime;
  const presence = new ConnectionPresence((error) => {
    throw error;
  });
  bindOwnerPresence(owner, presence);
  const attach = () =>
    presence.attach({
      connectionId: randomUUID(),
      hostId: 1,
      username: 'fixture',
      scope: { topic: 'session', session_id: id, binding_generation: 1, native_instance_id: instance },
    });
  const live = attach();
  const receiver = presence.attach({
    connectionId: randomUUID(),
    hostId: 1,
    username: 'fixture',
    scope: { topic: 'receiver', session_id: id, binding_generation: 1, receiver_generation: generation },
  });
  const input: ReceiverTurnProof = {
    epoch: randomUUID(),
    sequence: 1,
    state: 'unknown',
    native_instance_id: instance,
    binding_generation: 1,
  };
  const apply = (proof: ReceiverTurnProof) => {
    const accepted = acceptOwnedClaudeTurnProof(owner, session, proof);
    session = { ...session, activity: { turn_proof: accepted, expires_at: '2000-01-01T00:00:00.000Z' } };
    return accepted;
  };
  const idle = () => ownedClaudeTurnIdle(owner, {} as OwnerStateSnapshot, session);
  return {
    owner,
    presence,
    live,
    receiver,
    attach,
    input,
    apply,
    idle,
    change(patch: Partial<typeof session>) {
      session = { ...session, ...patch };
    },
  };
}
describe('Claude native turn boundary proof', () => {
  it('does not infer idle without ordered native evidence, and ignores activity age for a connected Stop boundary', () => {
    const h = fixture();
    expect(h.idle()).toBe(false);
    h.apply(h.input);
    expect(h.idle()).toBe(false);
    h.apply({ ...h.input, sequence: 2, state: 'idle' });
    expect(h.idle()).toBe(true);
    h.apply({ ...h.input, sequence: 3, state: 'active' });
    expect(h.idle()).toBe(false);
    h.apply({ ...h.input, sequence: 4, state: 'unknown' });
    expect(h.idle()).toBe(false);
    h.presence.close();
  });
  it('requires unknown bootstrap for a new epoch and never accepts a stale or contradictory idle event', () => {
    const h = fixture();
    h.apply({ ...h.input, sequence: 2, state: 'idle' });
    expect(h.idle()).toBe(false);
    h.apply({ ...h.input, sequence: 3, state: 'idle' });
    expect(h.idle()).toBe(true);
    h.apply({ ...h.input, sequence: 4, state: 'active' });
    h.apply({ ...h.input, sequence: 3, state: 'idle' });
    expect(h.idle()).toBe(false);
    h.apply({ ...h.input, sequence: 4, state: 'idle' });
    expect(h.idle()).toBe(false);
    h.apply({ ...h.input, epoch: randomUUID(), sequence: 8, state: 'idle' });
    expect(h.idle()).toBe(false);
    h.presence.close();
  });
  it('does not revive cached idle after exact-instance reconnect', () => {
    const h = fixture();
    h.apply(h.input);
    h.apply({ ...h.input, sequence: 2, state: 'idle' });
    expect(h.idle()).toBe(true);
    h.live.detach();
    expect(h.idle()).toBe(false);
    h.attach();
    expect(h.idle()).toBe(false);
    h.apply({ ...h.input, sequence: 2, state: 'idle' });
    expect(h.idle()).toBe(false);
    h.apply({ ...h.input, sequence: 3, state: 'idle' });
    expect(h.idle()).toBe(true);
    h.presence.close();
  });
  it.each(['binding', 'native', 'ended', 'receiver', 'instance'] as const)('fences %s changes', (change) => {
    const h = fixture();
    h.apply(h.input);
    h.apply({ ...h.input, sequence: 2, state: 'idle' });
    if (change === 'binding') h.change({ bindingGeneration: 2 });
    if (change === 'native') h.change({ upstreamSessionId: 'other' });
    if (change === 'ended') h.change({ endedAt: new Date().toISOString() });
    if (change === 'receiver') h.receiver.detach();
    if (change === 'instance') h.live.detach();
    expect(h.idle()).toBe(false);
    expect(() => h.apply({ ...h.input, sequence: 3, state: 'idle' })).toThrow();
    h.presence.close();
  });
});

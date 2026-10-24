import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionPresence } from '../../../src/control-plane/presence.js';

describe('connection-owned presence', () => {
  it('starts empty and distinguishes native session, receiver and upstream connection', () => {
    const presence = new ConnectionPresence(vi.fn()),
      session = randomUUID(),
      connection = randomUUID();
    const base = { connectionId: connection, hostId: 1, username: 'user' };
    expect(presence.hasSession(session, 1)).toBe(false);
    const native = presence.attach({
      ...base,
      scope: { topic: 'session', session_id: session, binding_generation: 1 },
    });
    const receiver = presence.attach({
      ...base,
      scope: {
        topic: 'receiver',
        session_id: session,
        binding_generation: 1,
        receiver_generation: 'receiver-1',
      },
    });
    expect(presence.hasSession(session, 1)).toBe(true);
    expect(presence.hasReceiver(session, 1, 'receiver-1')).toBe(true);
    receiver.detach();
    expect(presence.hasSession(session, 1)).toBe(true);
    expect(presence.hasReceiver(session, 1, 'receiver-1')).toBe(false);
    native.detach();
    expect(presence.size()).toBe(0);
  });
  it('a delayed old-generation detach never evicts a replacement', () => {
    const presence = new ConnectionPresence(vi.fn()),
      session = randomUUID();
    const old = presence.attach({
      connectionId: 'old',
      hostId: 1,
      username: 'u',
      scope: { topic: 'session', session_id: session, binding_generation: 1 },
    });
    const fresh = presence.attach({
      connectionId: 'new',
      hostId: 1,
      username: 'u',
      scope: { topic: 'session', session_id: session, binding_generation: 2 },
    });
    presence.disconnect('old');
    old.detach();
    expect(presence.hasSession(session, 1)).toBe(false);
    expect(presence.hasSession(session, 2)).toBe(true);
    fresh.detach();
    expect(presence.size()).toBe(0);
  });
  it('retains exact relay/provider membership and clears it on owner loss', () => {
    const presence = new ConnectionPresence(vi.fn()),
      changed = vi.fn();
    presence.subscribe(changed);
    presence.attach({
      connectionId: 'upstream',
      hostId: 1,
      username: 'u',
      scope: { topic: 'relay', relay_id: 'relay-id' },
    });
    presence.attach({
      connectionId: 'upstream',
      hostId: 1,
      username: 'u',
      scope: { topic: 'provider', provider_session_id: 'provider-id' },
    });
    expect(presence.hasRelay('relay-id')).toBe(true);
    expect(presence.hasProvider('provider-id')).toBe(true);
    presence.close();
    expect(presence.hasRelay('relay-id')).toBe(false);
    expect(presence.hasProvider('provider-id')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(4);
  });
});

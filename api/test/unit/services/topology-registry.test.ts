import { describe, expect, it, vi } from 'vitest';
import {
  CommunicatorRegistry,
  sessionIdFromPath,
  sessionIdFromRegistration,
  type CommunicatorHandle,
  type CommunicatorView,
} from '../../../src/services/topology/communicator-registry.js';

const SESSION = '3a864600-a1ee-42f2-9f8b-3d569e2220b5';
const OTHER = '0eed881f-ba5a-4983-9b80-caf25052428e';

const view = (id: string, overrides: Partial<CommunicatorView> = {}): CommunicatorView => ({
  id,
  host_id: 4,
  username: 'alice',
  version: '0.9.74',
  connected_at: new Date(1_000_000).toISOString(),
  sessions: 0,
  requests: 0,
  synced_at: null,
  ...overrides,
});

function handle(registry: CommunicatorRegistry, id: string, behaviour: 'honours' | 'ignores' = 'honours') {
  const close = vi.fn(() => {
    if (behaviour === 'honours') queueMicrotask(() => registry.unregister(id));
  });
  const terminate = vi.fn(() => queueMicrotask(() => registry.unregister(id)));
  return { close, terminate, remoteAddress: '192.0.2.9' } satisfies CommunicatorHandle;
}

describe('session identity in request paths', () => {
  it('names the session only for /host/agent-sessions/<uuid>/…', () => {
    expect(sessionIdFromPath(`/host/agent-sessions/${SESSION}/heartbeat`)).toBe(SESSION);
    expect(sessionIdFromPath(`/host/agent-sessions/${SESSION.toUpperCase()}/receiver/claim`)).toBe(SESSION);
    expect(sessionIdFromPath(`/host/agent-sessions/${SESSION}`)).toBe(SESSION);
    expect(sessionIdFromPath('/host/agent-sessions')).toBeNull();
    expect(sessionIdFromPath('/host/agent-sessions/not-a-uuid/heartbeat')).toBeNull();
    expect(sessionIdFromPath(`/host/other/agent-sessions/${SESSION}/heartbeat`)).toBeNull();
    expect(sessionIdFromPath(`/mcp/${SESSION}`)).toBeNull();
  });

  it('reads the id from a registration reply, enveloped or not', () => {
    expect(sessionIdFromRegistration({ data: { session_id: SESSION } })).toBe(SESSION);
    expect(sessionIdFromRegistration({ session_id: SESSION })).toBe(SESSION);
    expect(sessionIdFromRegistration({ enabled: false })).toBeNull();
    expect(sessionIdFromRegistration({ session_id: 'x' })).toBeNull();
    expect(sessionIdFromRegistration(null)).toBeNull();
  });
});

describe('session traffic evidence', () => {
  it('records only requests the API accepted', () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), handle(registry, 'c1'));
    registry.observeDispatch('c1', 'POST', `/host/agent-sessions/${SESSION}/heartbeat`, 403);
    registry.observeDispatch('c1', 'POST', `/host/agent-sessions/${SESSION}/heartbeat`, 409);
    expect(registry.get('c1')!.evidence.size).toBe(0);
    registry.observeDispatch('c1', 'POST', `/host/agent-sessions/${SESSION}/heartbeat`, 200);
    const evidence = registry.get('c1')!.evidence.get(SESSION)!;
    expect(evidence.requests).toBe(1);
    expect(evidence.last_route).toBe('POST /host/agent-sessions/:id/heartbeat');
  });

  it('learns a session from its registration reply', () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), handle(registry, 'c1'));
    registry.observeDispatch('c1', 'POST', '/host/agent-sessions', 200, Buffer.from(JSON.stringify({ data: { session_id: SESSION } })));
    registry.observeDispatch('c1', 'POST', '/host/agent-sessions', 200, Buffer.from('not json'));
    registry.observeDispatch('c1', 'POST', '/host/agent-sessions', 200, Buffer.from(JSON.stringify({ enabled: false })));
    expect([...registry.get('c1')!.evidence.keys()]).toEqual([SESSION]);
  });

  it('ignores traffic that names no session and connections that are gone', () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), handle(registry, 'c1'));
    registry.observeDispatch('c1', 'POST', '/auth', 200);
    registry.observeDispatch('c1', 'POST', '/mcp', 200);
    registry.observeDispatch('ghost', 'POST', `/host/agent-sessions/${SESSION}/heartbeat`, 200);
    expect(registry.get('c1')!.evidence.size).toBe(0);
  });

  it('keeps one socket\'s evidence apart from another\'s', () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), handle(registry, 'c1'));
    registry.register(view('c2'), handle(registry, 'c2'));
    registry.observeDispatch('c1', 'POST', `/host/agent-sessions/${SESSION}/heartbeat`, 200);
    registry.observeDispatch('c2', 'POST', `/host/agent-sessions/${OTHER}/heartbeat`, 200);
    expect([...registry.get('c1')!.evidence.keys()]).toEqual([SESSION]);
    expect([...registry.get('c2')!.evidence.keys()]).toEqual([OTHER]);
  });

  it('drops evidence that is too old to say anything about the present', () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), handle(registry, 'c1'));
    const t0 = 5_000_000;
    registry.observeSession('c1', SESSION, 'POST /x', t0);
    expect(registry.snapshot(t0 + 60_000)[0]!.evidence.size).toBe(1);
    expect(registry.snapshot(t0 + 11 * 60_000)[0]!.evidence.size).toBe(0);
  });

  it('is bounded per connection and evicts the stalest session first', () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), handle(registry, 'c1'));
    for (let i = 0; i < 2048; i++) registry.observeSession('c1', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 'r', 1000 + i);
    registry.observeSession('c1', SESSION, 'r', 9_000);
    const evidence = registry.get('c1', 9_001)!.evidence;
    expect(evidence.size).toBe(2048);
    expect(evidence.has(SESSION)).toBe(true);
    expect(evidence.has('00000000-0000-4000-8000-000000000000')).toBe(false);
  });
});

describe('admin disconnect', () => {
  it('reports closed once the socket\'s close handler has run', async () => {
    const registry = new CommunicatorRegistry();
    const h = handle(registry, 'c1');
    registry.register(view('c1'), h);
    registry.observeSession('c1', SESSION, 'r');
    const result = await registry.disconnect('c1', 'ops');
    expect(result.outcome).toBe('closed');
    expect(h.close).toHaveBeenCalledWith(4001, 'Closed by administrator');
    expect(h.terminate).not.toHaveBeenCalled();
    expect(registry.has('c1')).toBe(false);
    const [tombstone] = registry.tombstones();
    expect(tombstone).toMatchObject({ id: 'c1', reason: 'admin_disconnect', actor: 'ops', session_ids: [SESSION] });
  });

  it('terminates a transport whose peer ignores the close handshake', async () => {
    const registry = new CommunicatorRegistry();
    const h = handle(registry, 'c1', 'ignores');
    registry.register(view('c1'), h);
    const result = await registry.disconnect('c1', 'ops', { graceMs: 20, timeoutMs: 200 });
    expect(result.outcome).toBe('closed');
    expect(h.terminate).toHaveBeenCalledTimes(1);
  });

  it('says "requested", not "closed", when nothing confirms it', async () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), { close: vi.fn(), terminate: vi.fn(), remoteAddress: null });
    const result = await registry.disconnect('c1', 'ops', { graceMs: 10, timeoutMs: 60 });
    expect(result.outcome).toBe('requested');
    expect(registry.has('c1')).toBe(true);
  });

  it('is a clean no-op for a connection that is already gone', async () => {
    const registry = new CommunicatorRegistry();
    expect(await registry.disconnect('nope', 'ops')).toEqual({ outcome: 'not_connected' });
  });

  it('marks a closing connection so the view can say so', async () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), { close: vi.fn(), remoteAddress: null });
    void registry.disconnect('c1', 'ops', { graceMs: 10, timeoutMs: 30 });
    expect(registry.get('c1')!.closing).toBe(true);
  });
});

describe('reconnect correlation', () => {
  it('links a disconnect to the next connection from the same host and OS user', () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), handle(registry, 'c1'), 1000);
    registry.unregister('c1', 2000);
    registry.register(view('c2'), handle(registry, 'c2'), 3000);
    expect(registry.tombstones(3001)[0]).toMatchObject({ id: 'c1', reason: 'peer_closed', successor_id: 'c2' });
  });

  it('does not link a different user, a different host, or a late return', () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), handle(registry, 'c1'), 1000);
    registry.unregister('c1', 2000);
    registry.register(view('c2', { username: 'bob' }), handle(registry, 'c2'), 3000);
    registry.register(view('c3', { host_id: 9 }), handle(registry, 'c3'), 3000);
    registry.register(view('c4'), handle(registry, 'c4'), 2000 + 3 * 60_000);
    expect(registry.tombstones(2000 + 3 * 60_000)[0]!.successor_id).toBeNull();
  });

  it('claims each tombstone at most once', () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), handle(registry, 'c1'), 1000);
    registry.unregister('c1', 2000);
    registry.register(view('c2'), handle(registry, 'c2'), 3000);
    registry.register(view('c3'), handle(registry, 'c3'), 3500);
    expect(registry.tombstones(3600)[0]!.successor_id).toBe('c2');
  });

  it('forgets old tombstones', () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('c1'), handle(registry, 'c1'), 1000);
    registry.unregister('c1', 2000);
    expect(registry.tombstones(2000 + 16 * 60_000)).toEqual([]);
  });
});

describe('acknowledged owner termination', () => {
  const capable = { terminate: true, pid: 4242, started_at: '2026-10-13T17:00:00Z' };
  function owner(registry: CommunicatorRegistry, id: string, answer: (frame: { request_id: string }) => void) {
    const send = vi.fn((frame: unknown) => queueMicrotask(() => answer(frame as { request_id: string })));
    registry.register(view(id), { close: vi.fn(), send, remoteAddress: null });
    registry.setCapabilities(id, capable);
    return send;
  }

  it('reports terminated only after the owner acknowledged and its connection closed', async () => {
    const registry = new CommunicatorRegistry();
    const send = owner(registry, 'c1', (frame) => {
      registry.acknowledgeTerminate('c1', frame.request_id, { accepted: true, pid: 4242, reason: null });
      setTimeout(() => registry.unregister('c1'), 20);
    });
    const result = await registry.terminate('c1', 'ops', { ackMs: 500, closeMs: 500 });
    expect(result).toMatchObject({ outcome: 'terminated', pid: 4242 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminate', reason: 'admin' }));
    expect(registry.tombstones()[0]).toMatchObject({ reason: 'admin_terminate', actor: 'ops', pid: 4242, process_started_at: '2026-10-13T17:00:00Z' });
  });

  it('says only "acknowledged" while the connection is still open', async () => {
    const registry = new CommunicatorRegistry();
    owner(registry, 'c1', (frame) => registry.acknowledgeTerminate('c1', frame.request_id, { accepted: true, pid: 4242, reason: null }));
    const result = await registry.terminate('c1', 'ops', { ackMs: 500, closeMs: 60 });
    expect(result.outcome).toBe('acknowledged');
    expect(registry.has('c1')).toBe(true);
  });

  it('never claims a stop that nothing acknowledged', async () => {
    const registry = new CommunicatorRegistry();
    owner(registry, 'c1', () => undefined);
    const result = await registry.terminate('c1', 'ops', { ackMs: 60, closeMs: 60 });
    expect(result.outcome).toBe('unacknowledged');
    // The connection was not marked as going away: nothing said it was.
    expect(registry.get('c1')!.closing).toBe(false);
  });

  it('reports a refusal with the owner\'s reason', async () => {
    const registry = new CommunicatorRegistry();
    owner(registry, 'c1', (frame) => registry.acknowledgeTerminate('c1', frame.request_id, { accepted: false, pid: null, reason: 'unsupported' }));
    expect(await registry.terminate('c1', 'ops', { ackMs: 500 })).toMatchObject({ outcome: 'refused', reason: 'unsupported' });
  });

  it('ignores an acknowledgement for another request', async () => {
    const registry = new CommunicatorRegistry();
    owner(registry, 'c1', () => registry.acknowledgeTerminate('c1', 'someone-elses-request', { accepted: true, pid: 1, reason: null }));
    expect((await registry.terminate('c1', 'ops', { ackMs: 60 })).outcome).toBe('unacknowledged');
  });

  it('is unsupported for an owner that never announced the capability, and single-flight otherwise', async () => {
    const registry = new CommunicatorRegistry();
    registry.register(view('old'), { close: vi.fn(), send: vi.fn(), remoteAddress: null });
    expect((await registry.terminate('old', 'ops')).outcome).toBe('unsupported');
    expect((await registry.terminate('ghost', 'ops')).outcome).toBe('not_connected');

    owner(registry, 'c2', () => undefined);
    const first = registry.terminate('c2', 'ops', { ackMs: 150 });
    expect((await registry.terminate('c2', 'ops', { ackMs: 150 })).outcome).toBe('in_progress');
    expect((await first).outcome).toBe('unacknowledged');
  });
});

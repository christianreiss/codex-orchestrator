import { claimOwnedDelivery } from '../../../src/services/agent-messaging/owned-claim.js';
import {
  acceptOwnedClaudeTurnProof,
  ownedClaudeTurnIdle,
} from '../../../src/control-plane/state/receiver-turn-proof.js';
import { ConnectionCredentials } from '../../../src/control-plane/credentials.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import type { StateSeed, StateRow } from '../../../src/control-plane/state/catalog.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { bindOwnerPresence, ConnectionPresence } from '../../../src/control-plane/presence.js';
import { OwnerStateProvider } from '../../../src/control-plane/streams/provider.js';
import { StreamAuthorization, sha256 } from '../../../src/control-plane/streams/authorization.js';
import { ControlStateStreams, type StateFrame } from '../../../src/control-plane/protocol.js';
import type { Host } from '../../../src/db/schema.js';
import { schedulePolicy, watchdogPolicy } from '../../../src/control-plane/streams/policies.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});
function harness(extra: StateSeed = {}) {
  const host = {
    id: 1,
    apiKey: 'fixture',
    apiKeyHash: null,
    status: 'active',
    secure: 1,
    engines: 'codex,claude,grok',
    ip4: null,
    ip6: null,
    allowRoamingIps: 0,
    reverseDnsMode: 0,
    expiresAt: null,
  } as Host;
  const id = randomUUID(),
    address = randomUUID(),
    receiver = 'receiver-generation';
  const session = {
    id,
    hostId: 1,
    username: 'user',
    engine: 'codex',
    bindingGeneration: 3,
    agentBusAddressId: address,
    bridgeTokenHash: sha256('bridge'),
    hostAuthFingerprint: sha256('fixture'),
    bridgeExpiresAt: new Date(Date.now() + 600000).toISOString(),
    expiresAt: null,
    endedAt: null,
    upstreamSessionId: 'native',
    activeTurnId: null,
    closeRequestedAt: null,
    receiver: {
      generation: receiver,
      protocol: 'codex-queue-v1',
      native_session_id: 'native',
      heartbeat_at: new Date().toISOString(),
      failure: null,
      probes: { peer: {}, portal: {} },
    },
  } as StateRow<'agentSessions'>;
  const seed = {
    hosts: [host],
    agentSessions: [session],
    agentBusAddresses: [
      {
        id: address,
        hostId: 1,
        username: 'user',
        engine: 'codex',
        enabled: 1,
        archivedAt: null,
        currentSessionId: id,
        bindingGeneration: 3,
      },
    ],
    versions: [
      { name: 'agent_messaging_enabled', version: '1' },
      { name: 'agent_portal_enabled', version: '1' },
    ],
    ...extra,
  } as StateSeed;
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed));
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  cleanups.push(() => deadlines.close());
  const execute = vi.fn(() => Promise.reject(new Error('Unexpected persistence')));
  const runtime: OwnerRuntime = { state, deadlines, assertOwner() {}, execute };
  const presence = new ConnectionPresence((error) => {
    throw error;
  });
  bindOwnerPresence(runtime, presence);
  const credentials = new ConnectionCredentials(runtime, presence, { session: 600000, relay: 600000 });
  cleanups.push(() => credentials.close());
  const provider = new OwnerStateProvider(
    runtime,
    new StreamAuthorization(runtime, 1, host),
    'connection',
    'user',
  );
  const publish = (table: 'agentSessions' | 'agentBusMessages' | 'versions', row: unknown) => {
    const draft = state.begin();
    draft.upsert(table, row as never);
    state.publish(draft.seal({ ...state.revision(), sequence: state.revision().sequence + 1n }));
  };
  return { state, provider, presence, runtime, execute, id, address, receiver, session, publish };
}
describe('owner state projections', () => {
  it('does no projection authorization for unrelated publications across 100 streams', async () => {
    const h = harness();
    const authorize = vi.spyOn(h.provider.authorization, 'session');
    const changed = vi.fn();
    for (let n = 0; n < 100; n++) {
      const projection = await h.provider.open(
        { topic: 'session', session_id: h.id },
        { bridge_token: 'bridge' },
      );
      const off = projection.subscribe(changed);
      cleanups.push(() => {
        off();
        void projection.detach();
      });
    }
    authorize.mockClear();
    changed.mockClear();
    const started = performance.now();
    for (let n = 0; n < 100; n++) h.publish('versions', { name: 'unrelated', version: String(n) });
    console.info(
      JSON.stringify({
        benchmark: '100 streams x 100 unrelated publications',
        authorizationCalls: authorize.mock.calls.length,
        elapsedMs: performance.now() - started,
      }),
    );
    expect(authorize.mock.calls.length).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    h.publish('versions', { name: 'api_disabled', version: '1' });
    expect(authorize).toHaveBeenCalled();
    expect(changed.mock.calls.length).toBeGreaterThanOrEqual(100);
  });
  it.each(['api_disabled', 'codex_engine_disabled', 'agent_messaging_enabled', 'agent_portal_enabled'])(
    'observes global %s changes through the publication filter',
    async (key) => {
      const h = harness();
      const projection = await h.provider.open(
        { topic: 'receiver', session_id: h.id, receiver_generation: h.receiver },
        { bridge_token: 'bridge' },
      );
      const changed = vi.fn(),
        off = projection.subscribe(changed);
      cleanups.push(() => {
        off();
        void projection.detach();
      });
      h.publish('versions', { name: key, version: key.endsWith('_enabled') ? '0' : '1' });
      expect(changed).toHaveBeenCalled();
    },
  );
  it('ignores foreign receiver work but observes source and own work changes', async () => {
    const h = harness();
    const projection = await h.provider.open(
      { topic: 'receiver', session_id: h.id, receiver_generation: h.receiver },
      { bridge_token: 'bridge' },
    );
    const changed = vi.fn(),
      off = projection.subscribe(changed);
    cleanups.push(() => {
      off();
      void projection.detach();
    });
    const authorize = vi.spyOn(h.provider.authorization, 'session');
    const message = {
      id: randomUUID(),
      targetAddressId: randomUUID(),
      status: 'queued',
      updatedAt: new Date().toISOString(),
      nextAttemptAt: null,
      leaseUntil: null,
    };
    h.publish('agentBusMessages', message);
    expect(authorize.mock.calls.length).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    h.publish('agentBusMessages', { ...message, targetAddressId: h.address });
    expect(changed).toHaveBeenCalledTimes(1);
    h.publish('agentSessions', { ...h.session, receiver: { ...h.session.receiver!, portal_closed: true } });
    expect(changed).toHaveBeenCalledTimes(2);
    expect((projection.snapshot() as { sources: string[] }).sources).toEqual(['peer']);
  });
  it('keeps credential renewal and absolute expiry callbacks independent of table changes', async () => {
    vi.useFakeTimers();
    const h = harness();
    const streams = new ControlStateStreams(h.provider, {
      send: vi.fn(),
      bufferedBytes: () => 0,
      error: vi.fn(),
    });
    streams.delegateTransportLiveness();
    cleanups.push(() => streams.close());
    await streams.receive({
      type: 'state_open',
      protocol: 1,
      stream_id: randomUUID(),
      scope: { topic: 'session', session_id: h.id },
      auth: { bridge_token: 'bridge' },
    });
    const authorize = vi.spyOn(h.provider.authorization, 'session');
    await vi.advanceTimersByTimeAsync(300000);
    expect(authorize).toHaveBeenCalled();
    expect(streams.size()).toBe(1);
    h.publish('agentSessions', { ...h.session, expiresAt: new Date(Date.now() + 5000).toISOString() });
    await vi.advanceTimersByTimeAsync(5000);
    expect(streams.size()).toBe(0);
  });

  it('keeps idle transport pings free of persistence and exposes generation-bound presence', async () => {
    vi.useFakeTimers();
    const h = harness();
    const frames: StateFrame[] = [];
    const streams = new ControlStateStreams(h.provider, {
      send: (frame) => frames.push(frame),
      bufferedBytes: () => 0,
      error: () => {},
    });
    cleanups.push(() => streams.close());
    const stream = randomUUID();
    await streams.receive({
      type: 'state_open',
      protocol: 1,
      stream_id: stream,
      scope: { topic: 'session', session_id: h.id },
      auth: { bridge_token: 'bridge' },
    });
    expect(frames[0]?.type).toBe('state_snapshot');
    expect(h.presence.hasSession(h.id, 3)).toBe(true);
    for (let n = 0; n < 10; n++) {
      await vi.advanceTimersByTimeAsync(15000);
      await streams.receive({
        type: 'state_pong',
        protocol: 1,
        stream_id: stream,
        owner_epoch: h.provider.epoch,
      });
    }
    expect(frames.filter((f) => f.type === 'state_snapshot' || f.type === 'state_delta')).toHaveLength(1);
    expect(h.execute).not.toHaveBeenCalled();
    h.publish('agentSessions', { ...h.session, bindingGeneration: 4 });
    await Promise.resolve();
    expect(frames.at(-1)?.type).toBe('state_close');
    expect(h.presence.hasSession(h.id, 3)).toBe(false);
  });
  it('wakes deferred Claude work when only the authoritative idle proof commits after an empty claim', async () => {
    const h = harness(),
      instance = randomUUID(),
      epoch = randomUUID();
    h.publish('agentSessions', {
      ...h.session,
      engine: 'claude',
      receiver: {
        ...(h.session.receiver as Record<string, unknown>),
        protocol: 'claude-channel-v1',
        delivery_timing_v1: true,
      },
    });
    const native = h.presence.attach({
      connectionId: randomUUID(),
      hostId: 1,
      username: 'user',
      scope: {
        topic: 'session',
        session_id: h.id,
        binding_generation: 3,
        native_instance_id: instance,
      },
    });
    const draft = h.state.begin();
    draft.upsert('agentNativeControls', {
      sessionId: h.id,
      instanceId: instance,
      bindingGeneration: 3,
      status: 'ready',
    } as never);
    h.state.publish(draft.seal({ ...h.state.revision(), sequence: h.state.revision().sequence + 1n }));
    const p = await h.provider.open(
      { topic: 'receiver', session_id: h.id, binding_generation: 3, receiver_generation: h.receiver },
      { bridge_token: 'bridge' },
    );
    const changed = vi.fn(),
      off = p.subscribe(changed);
    cleanups.push(() => {
      off();
      native.detach();
      void p.detach();
    });
    const proof = (state: 'unknown' | 'active' | 'idle', sequence: number) => {
      const current = h.state.snapshot().sessions.get(h.id)!;
      const accepted = acceptOwnedClaudeTurnProof(h.runtime, current, {
        epoch,
        state,
        sequence,
        native_instance_id: instance,
        binding_generation: 3,
      });
      h.publish('agentSessions', { ...current, activity: { turn_proof: accepted } });
    };
    proof('unknown', 1);
    proof('active', 2);
    h.publish('agentBusMessages', {
      id: randomUUID(),
      targetAddressId: h.address,
      kind: 'message',
      workKind: null,
      deliveryTiming: 'after_turn',
      status: 'queued',
      dispatchOrder: 1,
      nextAttemptAt: '2000-01-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const before = (p.snapshot() as { work_revision: string }).work_revision;
    // Local Stop opens the wrapper gate before the asynchronous activity POST
    // commits. The actual owner claim must remain an empty RAM read meanwhile.
    expect(
      await claimOwnedDelivery({} as never, h.runtime, {} as never, {
        targetAddressIds: [h.address],
        leaseOwner: `session:${h.id}`,
        claimId: randomUUID(),
        relayGeneration: null,
        skipReceiveCapable: false,
        receiverGeneration: h.receiver,
        informationalOnly: false,
        deliveryTimingEnabled: true,
        smartQueue: false,
        peerBatch: false,
      }),
    ).toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
    changed.mockClear();
    proof('idle', 3);
    expect(ownedClaudeTurnIdle(h.runtime, h.state.snapshot(), h.state.snapshot().sessions.get(h.id)!)).toBe(
      true,
    );
    expect((p.snapshot() as { work_revision: string }).work_revision).not.toBe(before);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
    const idleRevision = (p.snapshot() as { work_revision: string }).work_revision;
    // Heartbeat/proof freshness alone is not another reason to poll the queue.
    changed.mockClear();
    proof('idle', 4);
    const idle = h.state.snapshot().sessions.get(h.id)!;
    h.publish('agentSessions', {
      ...idle,
      activity: {
        ...(idle.activity as Record<string, unknown>),
        observed_at: new Date().toISOString(),
        expires_at: '2099-01-01T00:00:00Z',
      },
    });
    expect((p.snapshot() as { work_revision: string }).work_revision).toBe(idleRevision);
    expect(changed).not.toHaveBeenCalled();
    proof('active', 5);
    expect(changed).toHaveBeenCalledTimes(1);
    const activeRevision = (p.snapshot() as { work_revision: string }).work_revision;
    changed.mockClear();
    proof('active', 6);
    expect((p.snapshot() as { work_revision: string }).work_revision).toBe(activeRevision);
    expect(changed).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('wakes receiver on committed work and real retry deadline, but not unrelated settings', async () => {
    vi.useFakeTimers();
    const h = harness();
    const p = await h.provider.open(
      { topic: 'receiver', session_id: h.id, binding_generation: 3, receiver_generation: h.receiver },
      { bridge_token: 'bridge' },
    );
    const changed = vi.fn();
    const off = p.subscribe(changed);
    cleanups.push(() => {
      off();
      void p.detach();
    });
    const first = p.snapshot() as { work_revision: string };
    h.publish('versions', { name: 'unrelated', version: '1' });
    expect(changed).not.toHaveBeenCalled();
    h.publish('agentBusMessages', {
      id: randomUUID(),
      targetAddressId: h.address,
      status: 'queued',
      updatedAt: new Date().toISOString(),
      nextAttemptAt: new Date(Date.now() + 5000).toISOString(),
      leaseUntil: null,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect((p.snapshot() as { work_revision: string }).work_revision).not.toBe(first.work_revision);
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('rejects timed provider grants, even if their historical expiry is in the future', async () => {
    const id = 'a'.repeat(32);
    const h = harness({
      providerAccountSessions: [
        {
          id,
          hostId: 1,
          engine: 'codex',
          accountId: 1,
          ownershipMode: 'timed',
          expiresAt: '2099-01-01T00:00:00Z',
        },
      ] as never,
    });
    await expect(
      h.provider.open({ topic: 'provider', provider_session_id: id, engine: 'codex' }, {}),
    ).rejects.toThrow('does not support connection ownership');
    expect(h.presence.size()).toBe(0);
  });
  it('keeps a connection grant attached past its legacy timestamp and revokes on host policy change', async () => {
    const id = 'b'.repeat(32);
    const h = harness({
      providerAccounts: [{ id: 1, engine: 'claude', state: 'enabled' }] as never,
      providerAccountSessions: [
        {
          id,
          hostId: 1,
          engine: 'claude',
          accountId: 1,
          ownershipMode: 'connection',
          expiresAt: '2000-01-01T00:00:00Z',
        },
      ] as never,
    });
    const p = await h.provider.open({ topic: 'provider', provider_session_id: id, engine: 'claude' }, {});
    expect(h.presence.hasProvider(id)).toBe(true);
    expect(p.authorize().deadline).toBeNull();
    h.publish('versions', { name: 'api_disabled', version: '1' });
    expect(() => p.authorize()).toThrow('authorization changed');
    await p.detach();
  });
  it('suppresses schedule and watchdog timeouts for open prompts and excludes watchdog schedules', () => {
    const h = harness();
    const draft = h.state.begin();
    draft.upsert('agentSchedules', {
      id: 'schedule',
      targetAddressId: h.address,
      enabled: 1,
      persistent: 1,
      deletedAt: null,
      progressTimeoutSeconds: 10,
      nextDueAt: '2099-01-01T00:00:00Z',
    } as never);
    draft.upsert('agentWatchdogs', {
      id: 'watchdog',
      scheduleId: 'schedule',
      targetAddressId: h.address,
      nativeSessionId: 'native',
      status: 'watching',
      deadlineAt: '2099-01-01T00:00:00Z',
      progressTimeoutSeconds: 20,
      sessionId: h.id,
      quotaAccountId: null,
      lastError: 'hang',
    } as never);
    draft.upsert('agentPrompts', { id: 'prompt', sessionId: h.id, status: 'open' } as never);
    h.state.publish(draft.seal({ ...h.state.revision(), sequence: 1n }));
    expect(
      schedulePolicy(h.state.snapshot(), { ...h.session, activeTurnId: 'turn' }).progress_timeout_seconds,
    ).toBeNull();
    const watchdog = watchdogPolicy(h.state.snapshot(), h.session);
    expect(watchdog.progress_timeout_seconds).toBeNull();
    expect(watchdog.terminate_requested).toBe(false);
  });
});

import { AdvisorService } from '../../../src/services/advisor.js';
import { touchHostAuthFields, touchHostAuthState } from '../../../src/services/canonical-auth-store.js';
import { ENGINE_HOST_FIELDS } from '../../../src/util/engine.js';
import { relayLongPoll } from '../../../src/http/relay-long-poll.js';
import { ownerReadResponseGuard, withOwnerRequestScope } from '../../../src/control-plane/state/runtime.js';
import { GrokUsageService } from '../../../src/services/grok-usage.js';
import { ChatGptUsageService } from '../../../src/services/chatgpt-usage.js';
import {
  requestOwnedEngineDestroy,
  recordOwnedDestroyReport,
  purgeOwnedEngine,
  ownedDestroyProgress,
} from '../../../src/control-plane/streams/engine-destroy.js';
import { LegacyDrainRegistry, captureLegacyDrainManifest, legacyDrainDeadline } from '../../../src/control-plane/legacy-drain.js';
import {
  registerOwnedReceiver,
  updateOwnedReceiver,
  ownedReceiverReady,
  statusOwnedReceiver,
} from '../../../src/control-plane/streams/receiver.js';
import {
  registerOwnedRelay,
  ownedRelayTargets,
  heartbeatOwnedRelay,
} from '../../../src/control-plane/streams/relay.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { recordOwnedNativeReceipt } from '../../../src/control-plane/streams/native-control.js';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { bindOwnerPresence, ConnectionPresence } from '../../../src/control-plane/presence.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring, loadTestEnv } from '../../helpers/test-keyring.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { HostDaemonService } from '../../../src/services/host-daemon/service.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import { NativeStopService } from '../../../src/services/native-stop.js';
import { daemonSweepObligations } from '../../../src/control-plane/streams/daemon-deadlines.js';

const queues: DeadlineQueue[] = [];
afterEach(() => {
  queues.splice(0).forEach((q) => q.close());
  vi.useRealTimers();
});
function harness(extra: Record<string, Record<string, unknown>[]> = {}) {
  const now = new Date().toISOString();
  const seed = {
    hosts: [
      {
        id: 1,
        fqdn: 'fixture',
        apiKey: 'test',
        apiKeyHash: null,
        status: 'active',
        configVersion: 0,
        secure: 1,
        engines: 'codex,claude,grok',
        internalRole: null,
        expiresAt: null,
        insecureEnabledUntil: null,
      },
    ],
    hostDaemons: [
      {
        hostId: 1,
        settings: daemonSettingsSchema.parse({ enabled: true, username: 'user' }),
        runtime: null,
        enabledAt: now,
        updatedAt: now,
      },
    ],
    versions: [{ name: 'agent_messaging_enabled', version: '1' }],
    ...extra,
  };
  const fake = createDbFake(
    new Map(
      Object.entries(seed).map(([name, values]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone(values),
      ]),
    ),
  );
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
  );
  const deadlines = new DeadlineQueue((e) => {
    throw e;
  });
  queues.push(deadlines);
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(e) {
      throw e;
    },
    committed() {},
    notificationError(e) {
      throw e;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(fake as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const runtime: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  bindOwnerRuntime(fake, runtime);
  const presence = new ConnectionPresence((e) => {
    throw e;
  });
  bindOwnerPresence(runtime, presence);
  const ctx = { db: fake, keyring: testKeyring(), env: loadTestEnv() } as unknown as RouteContext;
  const service = new HostDaemonService(ctx);
  return { state, runtime, presence, fake, ctx, service };
}
describe('connection-owned daemon commands', () => {
  it.each(['codex', 'claude', 'grok'] as const)('persists %s canonical identity changes but not repeated auth contact', async (engine) => {
    const h = harness(), stamp = '2026-10-24T10:00:00Z', digest = 'a'.repeat(64);
    await touchHostAuthState(h.ctx.db, 1, 11, digest, engine);
    await touchHostAuthFields(h.ctx.db, 1, stamp, digest, engine);
    const execute = vi.spyOn(h.runtime, 'execute'), select = vi.spyOn(h.fake, 'select'), update = vi.spyOn(h.fake, 'update'), insert = vi.spyOn(h.fake, 'insert');
    const revision = h.state.revision(), before = h.state.snapshot().table('hostAuthStates').get([1, engine]);
    for (let i = 0; i < 20; i++) {
      await touchHostAuthState(h.ctx.db, 1, 11, digest, engine);
      await touchHostAuthFields(h.ctx.db, 1, stamp, digest, engine);
    }
    expect(execute).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
    expect(h.state.revision()).toEqual(revision);
    expect(h.state.snapshot().table('hostAuthStates').get([1, engine])).toEqual(before);
    await touchHostAuthState(h.ctx.db, 1, 12, digest, engine);
    await touchHostAuthFields(h.ctx.db, 1, stamp, 'b'.repeat(64), engine);
    expect(h.state.snapshot().table('hostAuthStates').get([1, engine])?.payloadId).toBe(12);
    expect(h.state.snapshot().hosts.get(1)?.[ENGINE_HOST_FIELDS[engine].authDigest]).toBe('b'.repeat(64));
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, 0])('parks unattached legacy protocol %s without reads, writes, presence or queued deliveries', async (protocol) => {
    const h = harness({ agentBusMessages: [{ id: 'queued', status: 'queued', targetAddressId: 'target' }], agentBusAddresses: [{ id: 'target', hostId: 1, username: 'user', engine: 'codex', enabled: 1, archivedAt: null, currentSessionId: null }] });
    const host = h.fake.tables.get(schema.hosts)![0] as typeof schema.hosts.$inferSelect;
    const registered = await registerOwnedRelay(h.runtime, host, { username: 'user', instanceId: randomUUID(), wrapperVersion: 'old', capabilities: protocol === undefined ? null : { control_state_protocol: protocol } });
    const id = String(registered.relay_id), token = String(registered.relay_token);
    const select = vi.spyOn(h.fake, 'select'), update = vi.spyOn(h.fake, 'update'), insert = vi.spyOn(h.fake, 'insert');
    const revision = h.state.revision();
    vi.useFakeTimers();
    let complete = false;
    const poll = vi.fn(async () => ownedRelayTargets(h.runtime, id, token));
    const result = relayLongPoll(poll, Date.now() + 25_000, () => false, undefined, { key: id, check: async () => ownedRelayTargets(h.runtime, id, token) === null }).then((value) => { complete = true; return value; });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull();
    expect(h.state.revision()).toEqual(revision);
    expect(h.state.snapshot().messages.get('queued')?.status).toBe('queued');
    expect(h.presence.all()).toEqual([]);
    expect(select).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
    expect(() => ownedRelayTargets(h.runtime, id, 'wrong')).toThrow('Invalid agent relay credential');
  });
  it.each(['generation', 'instance', 'fingerprint', 'expired', 'revoked', 'modern', 'host_deadline'])('revalidates legacy empty responses after %s changes', async (change) => {
    const h = harness();
    const host = h.fake.tables.get(schema.hosts)![0] as typeof schema.hosts.$inferSelect;
    const registered = await registerOwnedRelay(h.runtime, host, { username: 'user', instanceId: randomUUID(), wrapperVersion: 'old' });
    const id = String(registered.relay_id), token = String(registered.relay_token);
    withOwnerRequestScope(() => {
      expect(ownedRelayTargets(h.runtime, id, token)).toBeNull();
      const guard = ownerReadResponseGuard(h.runtime), draft = h.state.begin();
      const relay = draft.table('agentBusRelays').get(id)!;
      if (change === 'host_deadline') draft.upsert('hosts', { ...draft.table('hosts').get(1)!, secure: 0, insecureEnabledUntil: new Date('2000-01-01T00:00:00.000Z') });
      draft.upsert('agentBusRelays', { ...relay,
        ...(change === 'generation' ? { generation: relay.generation + 1 } : {}),
        ...(change === 'instance' ? { instanceId: randomUUID() } : {}),
        ...(change === 'fingerprint' ? { hostAuthFingerprint: 'revoked' } : {}),
        ...(change === 'expired' ? { tokenExpiresAt: '2000-01-01T00:00:00.000Z' } : {}),
        ...(change === 'revoked' ? { status: 'stopped' } : {}),
        ...(change === 'modern' ? { capabilities: { control_state_protocol: 1 } } : {}),
      });
      h.state.publish(draft.seal({ ...h.state.revision(), sequence: h.state.revision().sequence + 1n }));
      expect(guard).toThrow();
      if (change !== 'generation' && change !== 'instance') expect(() => ownedRelayTargets(h.runtime, id, token)).toThrow();
    });
  });
  it('does not persist unchanged heartbeat metadata and retains accepted work on disconnect', async () => {
    const h = harness(),
      instance = randomUUID();
    const hello = await h.service.connect(1, {
      instance_id: instance,
      username: 'user',
      version: 'test',
      engines: ['codex'],
      error: null,
    });
    const select = vi.spyOn(h.fake, 'select');
    const revision = h.state.revision().sequence;
    for (let i = 0; i < 10; i++) await h.service.heartbeat(1, hello.generation, ['codex'], null);
    expect(h.state.revision().sequence).toBe(revision);
    expect(select).not.toHaveBeenCalled();
    const started = await h.service.start(
      { host_id: 1, engine: 'codex', title: 'test', prompt: 'hello', client_message_id: randomUUID() },
      'admin:1',
    );
    const offer = await h.service.offer(1, hello.generation);
    expect(offer?.operation_id).toBe(started.operation_id);
    expect(offer?.prompt).toBe('hello');
    await h.service.accept(1, offer!.operation_id, offer!.claim_id);
    await h.service.disconnect(1, hello.generation);
    expect(h.state.snapshot().table('hostDaemonOperations').get(started.operation_id)?.status).toBe(
      'accepted',
    );
    expect(h.state.snapshot().table('hostDaemonSessions').get(started.session_id)?.status).toBe('running');
    await h.service.complete(1, offer!.operation_id, offer!.claim_id, { status: 'completed', reply: 'done' });
    expect(h.state.snapshot().table('hostDaemonOperations').get(started.operation_id)?.status).toBe(
      'completed',
    );
    expect(h.state.snapshot().table('hostDaemonSessions').get(started.session_id)?.status).toBe('idle');
    await expect(
      h.service.complete(1, offer!.operation_id, offer!.claim_id, {
        status: 'completed',
        reply: 'different',
      }),
    ).rejects.toThrow('already stored');
  });
  it('has no empty sweep deadline, and preserves an exact deadline across its due instant', async () => {
    const h = harness();
    expect(daemonSweepObligations(h.state.snapshot(), Date.now(), 24)).toEqual([]);
    const started = await h.service.start(
      { host_id: 1, engine: 'claude', title: 'test', prompt: 'hello', client_message_id: randomUUID() },
      'admin:1',
    );
    const before = daemonSweepObligations(h.state.snapshot(), Date.now(), 24)[0]!;
    expect(before.key).toBe('1');
    expect(daemonSweepObligations(h.state.snapshot(), before.dueAt, 24)[0]?.dueAt).toBe(before.dueAt);
    vi.useFakeTimers();
    vi.setSystemTime(before.dueAt);
    await h.service.sweep(1);
    expect(h.state.snapshot().table('hostDaemonOperations').get(started.operation_id)?.status).toBe(
      'expired',
    );
  });
  it('requires a live exact relay instance and refuses replacing unresolved work', async () => {
    const h = harness();
    const host = h.fake.tables.get(schema.hosts)![0] as typeof schema.hosts.$inferSelect;
    const instance = randomUUID(),
      address = randomUUID();
    const registration = await registerOwnedRelay(h.runtime, host, {
      username: 'user',
      instanceId: instance,
      wrapperVersion: 'test',
      capabilities: { control_state_protocol: 1 },
    });
    const id = String(registration.relay_id),
      token = String(registration.relay_token),
      generation = Number(registration.generation);
    expect(() => ownedRelayTargets(h.runtime, id, token)).toThrow('attachment unavailable');
    const attachment = h.presence.attach({
      connectionId: 'relay-proof',
      hostId: 1,
      username: 'user',
      scope: { topic: 'relay', relay_id: id, native_instance_id: instance, binding_generation: generation },
    });
    expect(ownedRelayTargets(h.runtime, id, token)).toBeNull();
    const revision = h.state.revision().sequence;
    for (let n = 0; n < 20; n++) heartbeatOwnedRelay(h.runtime, id, token);
    expect(h.state.revision().sequence).toBe(revision);
    await expect(
      registerOwnedRelay(h.runtime, host, {
        username: 'user',
        instanceId: randomUUID(),
        wrapperVersion: 'test',
      }),
    ).rejects.toThrow('still connected');
    attachment.detach();
    await mutateOwnerState(h.runtime, {
      kind: 'fixture.held',
      payload: {},
      prepare(c) {
        c.draft.upsert('agentBusMessages', {
          id: randomUUID(),
          targetAddressId: address,
          status: 'accepted',
          leaseOwner: `relay:${id}:${generation}`,
        } as never);
        return null;
      },
    });
    await expect(
      registerOwnedRelay(h.runtime, host, {
        username: 'user',
        instanceId: randomUUID(),
        wrapperVersion: 'test',
      }),
    ).rejects.toThrow('unresolved');
    const reattached = await registerOwnedRelay(h.runtime, host, {
      username: 'user',
      instanceId: instance,
      wrapperVersion: 'test',
    });
    expect(reattached.generation).toBe(generation);
  });
  it('keeps all three receiver engines ready by attachment with no periodic durable writes', async () => {
    for (const [engine, protocol] of [
      ['codex', 'codex-queue-v1'],
      ['claude', 'claude-channel-v1'],
      ['grok', 'grok-acp-v1'],
    ] as const) {
      const id = randomUUID(),
        address = randomUUID(),
        native = randomUUID(),
        generation = randomUUID(),
        token = 'fixture-bridge';
      const h = harness({
        agentSessions: [
          {
            id,
            hostId: 1,
            hostAuthFingerprint: createHash('sha256').update('test').digest('hex'),
            bridgeTokenHash: createHash('sha256').update(token).digest('hex'),
            bridgeExpiresAt: new Date(Date.now() + 600000).toISOString(),
            engine,
            username: 'user',
            agentBusAddressId: address,
            bindingGeneration: 1,
            endedAt: null,
            receiver: null,
          },
        ],
        agentBusAddresses: [
          {
            id: address,
            address: `agent:${address}`,
            hostId: 1,
            username: 'user',
            engine,
            currentSessionId: id,
            bindingGeneration: 1,
            enabled: 1,
            archivedAt: null,
            lastUpstreamSessionId: null,
          },
        ],
        versions: [
          { name: 'agent_messaging_enabled', version: '1' },
          { name: 'agent_portal_enabled', version: '1' },
        ],
      });
      const input = {
        generation,
        protocol,
        native_session_id: native,
        capabilities: { claim_gate_v1: true },
      };
      const execute = vi.spyOn(h.runtime, 'execute');
      const initialRevision = h.state.revision();
      for (let i = 0; i < 3; i++) await expect(registerOwnedReceiver(h.runtime, h.ctx.env, id, token, { ...input, generation: randomUUID() })).rejects.toThrow('Receiver connection unavailable');
      expect(execute).not.toHaveBeenCalled();
      expect(h.state.revision()).toEqual(initialRevision);
      h.presence.attach({ connectionId: 'session', hostId: 1, username: 'user', scope: { topic: 'session', session_id: id, binding_generation: 1 } });
      const registered = await registerOwnedReceiver(h.runtime, h.ctx.env, id, token, input);
      expect(registered.capabilities.control_state_protocol).toBe(1);
      expect(ownedReceiverReady(h.runtime, h.state.snapshot().sessions.get(id)!, 'peer')).toBe(false);
      const attachment = h.presence.attach({
        connectionId: 'receiver',
        hostId: 1,
        username: 'user',
        scope: { topic: 'receiver', session_id: id, binding_generation: 1, receiver_generation: generation },
      });
      const revision = h.state.revision().sequence;
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 120000);
      for (let n = 0; n < 10; n++)
        await updateOwnedReceiver(h.runtime, id, token, generation, 'heartbeat', {
          claim_gate: { state: 'work_active', seconds: 5 },
        });
      expect(h.state.revision().sequence).toBe(revision);
      expect(statusOwnedReceiver(h.runtime, id, token).receiver?.state).toBe('ready');
      await expect(
        registerOwnedReceiver(h.runtime, h.ctx.env, id, token, { ...input, generation: randomUUID() }),
      ).rejects.toThrow('Another receiver');
      attachment.detach();
      expect(ownedReceiverReady(h.runtime, h.state.snapshot().sessions.get(id)!, 'peer')).toBe(false);
      await updateOwnedReceiver(h.runtime, id, token, generation, 'stop', {
        failure: 'adapter_disconnected',
      });
      expect(statusOwnedReceiver(h.runtime, id, token).receiver?.state).toBe('failed');
      vi.useRealTimers();
    }
  });
  it('fences a native stop by proven instance attachment rather than a recent database timestamp', async () => {
    const id = randomUUID(),
      instance = randomUUID();
    const h = harness({
      agentSessions: [
        {
          id,
          hostId: 1,
          hostAuthFingerprint: createHash('sha256').update('test').digest('hex'),
          engine: 'grok',
          agentBusAddressId: null,
          bindingGeneration: 4,
          endedAt: null,
        },
      ],
    });
    const service = new NativeStopService(h.ctx.db);
    await service.poll(id, instance);
    expect((await service.get(id))?.available).toBe(false);
    const attachment = h.presence.attach({
      connectionId: 'fixture',
      hostId: 1,
      username: 'user',
      scope: { topic: 'session', session_id: id, binding_generation: 4, native_instance_id: instance },
    });
    const revision = h.state.revision().sequence;
    for (let n = 0; n < 10; n++) await service.poll(id, instance);
    expect(h.state.revision().sequence).toBe(revision);
    const stop = await service.request(id, randomUUID(), { instance_id: instance, binding_generation: 4 }, 1);
    expect(stop.request_id).toBeTruthy();
    await service.poll(id, instance, { request_id: stop.request_id!, status: 'exited' });
    await expect(
      service.poll(id, instance, { request_id: stop.request_id!, status: 'accepted' }),
    ).rejects.toThrow('already settled');
    const receipt = {
      session_id: id,
      binding_generation: 4,
      native_instance_id: instance,
      request_id: stop.request_id!,
      result: 'accepted' as const,
    };
    const beforeReceipt = h.state.revision().sequence;
    expect(await recordOwnedNativeReceipt(h.runtime, 1, receipt, () => {})).toEqual({ recorded: true });
    expect(h.state.revision().sequence).toBe(beforeReceipt);
    await expect(
      recordOwnedNativeReceipt(h.runtime, 1, { ...receipt, native_instance_id: randomUUID() }, () => {}),
    ).rejects.toThrow('identity changed');
    await expect(
      recordOwnedNativeReceipt(h.runtime, 1, { ...receipt, result: 'refused' }, () => {}),
    ).rejects.toThrow('contradicts');
    await expect(recordOwnedNativeReceipt(h.runtime, 2, receipt, () => {})).rejects.toThrow(
      'identity changed',
    );
    attachment.detach();
    expect((await service.get(id))?.available).toBe(false);
  });
});

describe('explicit legacy process drain', () => {
  it('renews only captured exact identities without writes and revokes on host transport policy change', async () => {
    const id = randomUUID(),
      instance = randomUUID(),
      generation = randomUUID(),
      native = randomUUID(),
      token = 'legacy-fixture',
      now = new Date().toISOString();
    const h = harness({
      agentSessions: [
        {
          id,
          hostId: 1,
          username: 'user',
          engine: 'codex',
          bindingGeneration: 1,
          endedAt: null,
          expiresAt: null,
          upstreamSessionId: native,
          hostAuthFingerprint: createHash('sha256').update('test').digest('hex'),
          bridgeTokenHash: createHash('sha256').update(token).digest('hex'),
          bridgeExpiresAt: new Date(Date.now() + 60000).toISOString(),
          adapterCapabilities: {},
          receiver: {
            generation,
            protocol: 'codex-queue-v1',
            native_session_id: native,
            heartbeat_at: now,
            failure: null,
            probes: { peer: {} },
          },
        },
      ],
      agentNativeControls: [
        {
          sessionId: id,
          instanceId: instance,
          bindingGeneration: 1,
          status: 'ready',
          requestId: null,
          updatedAt: now,
        },
      ],
    });
    const manifest = captureLegacyDrainManifest(h.state.snapshot());
    expect(manifest).toHaveLength(1);
    const registry = new LegacyDrainRegistry(h.runtime, manifest, { session: 600000, relay: 600000 });
    const revision = h.state.revision().sequence;
    for (let i = 0; i < 20; i++) {
      expect(registry.renew('session', id, token, { instanceId: instance })).toBe(true);
      await updateOwnedReceiver(h.runtime, id, token, generation, 'heartbeat', {});
    }
    expect(h.state.revision().sequence).toBe(revision);
    expect(h.presence.all()).toHaveLength(0);
    expect(ownedReceiverReady(h.runtime, h.state.snapshot().sessions.get(id)!, 'peer')).toBe(false);
    const replacement = randomUUID();
    await registerOwnedReceiver(h.runtime, h.ctx.env, id, token, {
      generation: replacement,
      protocol: 'codex-queue-v1',
      native_session_id: native,
    });
    expect(registry.receiver(id, 1, replacement)).toBe(true);
    const reboundRevision = h.state.revision();
    for (let i = 0; i < 5; i++) await updateOwnedReceiver(h.runtime, id, token, replacement, 'heartbeat', {});
    expect(h.state.revision()).toEqual(reboundRevision);
    await expect(
      registerOwnedReceiver(h.runtime, h.ctx.env, id, token, {
        generation: randomUUID(),
        protocol: 'codex-queue-v1',
        native_session_id: randomUUID(),
      }),
    ).rejects.toThrow('cannot be replaced');
    expect(() => registry.renew('session', id, token, { instanceId: randomUUID() })).toThrow(
      'does not match',
    );
    await mutateOwnerState(h.runtime, {
      kind: 'fixture.policy',
      payload: {},
      prepare(c) {
        c.draft.upsert('hosts', { ...c.snapshot.hosts.get(1)!, allowRoamingIps: 1 });
        return null;
      },
    });
    expect(registry.deadline(h.state.snapshot(), 'session', id)).toBeUndefined();
    registry.close();
  });
});

describe('owned engine destruction', () => {
  it.each(['codex', 'claude', 'grok'] as const)(
    'requires %s suspension and completed host cleanup before purge',
    async (engine) => {
      const h = harness({ versions: [{ name: `${engine}_engine_disabled`, version: '1' }] });
      await requestOwnedEngineDestroy(h.runtime, engine, 'fixture');
      const progress = ownedDestroyProgress(h.state.snapshot(), engine);
      expect(progress.counts.pending).toBe(1);
      await expect(purgeOwnedEngine(h.runtime, engine, { force: false, actor: 'fixture' })).rejects.toThrow(
        'not completed',
      );
      await recordOwnedDestroyReport(
        h.runtime,
        1,
        { engine, request_id: progress.request!.request_id, status: 'done' },
        [],
      );
      await purgeOwnedEngine(h.runtime, engine, { force: false, actor: 'fixture' });
      expect(h.state.snapshot().hosts.get(1)?.engines.split(',')).not.toContain(engine);
    },
  );
});

describe('owner provider observation writes', () => {
  it('persists Grok failure observation once and does not retry before its provider deadline', async () => {
    const h = harness({
      providerAccounts: [{ id: 7, engine: 'grok', state: 'enabled', mergedIntoAccountId: null }],
    });
    const ensureFresh = vi.fn(async () => {
      throw new Error('fixture unavailable');
    });
    const service = new GrokUsageService({ db: h.ctx.db, authOwner: { ensureFresh } });
    await service.refreshAccount(7);
    expect(h.state.snapshot().table('grokUsageSnapshots').get(7)?.checkedAt).toBeTruthy();
    const revision = h.state.revision().sequence;
    await service.refreshAccount(7);
    expect(ensureFresh).toHaveBeenCalledTimes(1);
    expect(h.state.revision().sequence).toBe(revision);
  });
  it('publishes a ChatGPT snapshot atomically and fences disabled accounts', async () => {
    const h = harness({
      providerAccounts: [{ id: 7, engine: 'codex', state: 'enabled', mergedIntoAccountId: null }],
    });
    const service = new ChatGptUsageService(h.ctx.db, undefined, { accountId: 7, keyring: h.ctx.keyring });
    const insert = (
      service as unknown as { insertSnapshot(v: Record<string, unknown>): Promise<{ id: number }> }
    ).insertSnapshot.bind(service);
    const now = new Date().toISOString(),
      row = await insert({
        status: 'ok',
        fetchedAt: now,
        nextEligibleAt: now,
        createdAt: now,
        primaryUsedPercent: 12,
      });
    expect(h.state.snapshot().table('chatgptUsageSnapshots').get(row.id)?.primaryUsedPercent).toBe(12);
    await mutateOwnerState(h.runtime, {
      kind: 'fixture.disable',
      payload: {},
      prepare(c) {
        c.draft.upsert('providerAccounts', { ...c.snapshot.accounts.get(7)!, state: 'disabled' });
        return null;
      },
    });
    await expect(
      insert({ status: 'ok', fetchedAt: now, nextEligibleAt: now, createdAt: now }),
    ).rejects.toThrow('no longer eligible');
  });
});

describe('owned advisor composition', () => {
  it.each(['codex', 'claude', 'grok'] as const)(
    '%s creates advisor and daemon atomically and closes without nested commands',
    async (engine) => {
      const callerId = randomUUID(),
        h = harness({
          hosts: [
            {
              id: 1,
              fqdn: 'advisor.internal',
              secure: 1,
              status: 'active',
              internalRole: 'advisor',
              engines: 'codex,claude,grok',
              expiresAt: null,
            },
          ],
          agentBusAddresses: [{ id: callerId, launchName: 'Caller', engine }],
        });
      const service = new AdvisorService(h.ctx);
      vi.spyOn(service, 'availability').mockResolvedValue({
        enabled: true,
        reason: 'ok',
        host_id: 1,
        engines: [engine],
        models: [{ engine, model: 'model', tier: 4 }],
        default: { engine, model: 'model' },
      });
      const select = vi.spyOn(h.fake, 'select'),
        request = { question: 'Review this', kind: 'verify', client_message_id: randomUUID() },
        caller = { session: { agentBusAddressId: callerId }, host: { fqdn: 'caller.test' } } as never;
      const before = h.state.revision().sequence,
        opened = await service.ask(caller, request);
      expect(h.state.revision().sequence).toBe(before + 1n);
      const advisor = h.state.snapshot().table('advisorSessions').all()[0]!;
      expect(h.state.snapshot().table('hostDaemonSessions').has(advisor.daemonSessionId)).toBe(true);
      expect(
        h.state.snapshot().table('hostDaemonOperations').by('sessionId', advisor.daemonSessionId),
      ).toHaveLength(1);
      expect(await service.ask(caller, request)).toEqual(opened);
      expect(h.state.revision().sequence).toBe(before + 1n);
      expect(select).not.toHaveBeenCalled();
      await service.close(caller, { advisor_session_id: advisor.id });
      expect(h.state.snapshot().table('advisorSessions').get(advisor.id)?.status).toBe('closed');
      expect(h.state.snapshot().table('hostDaemonSessions').get(advisor.daemonSessionId)?.status).toBe(
        'closed',
      );
      expect(h.state.revision().sequence).toBe(before + 2n);
    },
  );
  it('serializes competing opens against the last advisor slot', async () => {
    const callerId = randomUUID(),
      h = harness({
        hosts: [
          {
            id: 1,
            fqdn: 'advisor.internal',
            secure: 1,
            status: 'active',
            internalRole: 'advisor',
            engines: 'codex',
            expiresAt: null,
          },
        ],
        hostDaemons: [
          {
            hostId: 1,
            settings: daemonSettingsSchema.parse({ enabled: true, username: 'user', max_parallel: 1 }),
            runtime: null,
          },
        ],
        agentBusAddresses: [{ id: callerId, launchName: 'Caller', engine: 'codex' }],
      });
    const service = new AdvisorService(h.ctx);
    vi.spyOn(service, 'availability').mockResolvedValue({
      enabled: true,
      reason: 'ok',
      host_id: 1,
      engines: ['codex'],
      models: [{ engine: 'codex', model: 'model', tier: 4 }],
      default: { engine: 'codex', model: 'model' },
    });
    const caller = { session: { agentBusAddressId: callerId }, host: { fqdn: 'caller.test' } } as never;
    const results = await Promise.allSettled(
      [1, 2].map(() => service.ask(caller, { question: 'Review', client_message_id: randomUUID() })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.state.snapshot().table('advisorSessions').all()).toHaveLength(1);
    expect(h.state.snapshot().table('hostDaemonSessions').all()).toHaveLength(1);
  });
});

describe('captured legacy protected operations', () => {
  function fixture() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T15:00:00Z'));
    const id = randomUUID(),
      instance = randomUUID(),
      claimId = randomUUID(),
      gitId = randomUUID();
    const now = new Date().toISOString(),
      expiresAt = new Date(Date.now() + 60000).toISOString();
    const token = 'legacy-protected';
    const h = harness({
      agentSessions: [
        {
          id,
          hostId: 1,
          username: 'user',
          engine: 'codex',
          bindingGeneration: 1,
          endedAt: null,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          adapterCapabilities: {},
          receiver: null,
          upstreamSessionId: randomUUID(),
          bridgeTokenHash: createHash('sha256').update(token).digest('hex'),
          hostAuthFingerprint: createHash('sha256').update('test').digest('hex'),
          bridgeExpiresAt: expiresAt,
        },
      ],
      agentNativeControls: [
        { sessionId: id, instanceId: instance, bindingGeneration: 1, status: 'ready', updatedAt: now },
      ],
      agentResourceClaims: [
        {
          id: claimId,
          sessionId: id,
          generation: 1,
          nativeInstanceId: null,
          ownershipMode: 'timed',
          uncertaintyReason: null,
          requestId: randomUUID(),
          purpose: 'existing operation',
          resources: [{ kind: 'path', host_id: 1, path: '/repo' }],
          state: 'active',
          blockers: [],
          repliedAt: null,
          createdAt: now,
          updatedAt: now,
          expiresAt,
        },
      ],
      gitWorktrees: [
        {
          id: gitId,
          cloneId: randomUUID(),
          hostId: 1,
          worktreePath: '/repo',
          worktreeHash: 'hash',
          username: 'user',
          engine: 'codex',
          agentSessionId: id,
          agentBindingGeneration: 1,
          nativeInstanceId: null,
          ownershipMode: 'timed',
          uncertaintyReason: null,
          status: 'active',
          registeredAt: now,
          heartbeatAt: now,
          expiresAt,
          releasedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const capture = () =>
      captureLegacyDrainManifest(h.state.snapshot(), Date.now(), {
        resourceClaimIds: [claimId],
        gitRegistrationIds: [gitId],
      });
    const change = (run: (draft: ReturnType<typeof h.state.begin>) => void) => {
      const revision = h.state.revision(),
        draft = h.state.begin();
      run(draft);
      h.state.publish(draft.seal({ ...revision, sequence: revision.sequence + 1n }));
    };
    return { ...h, id, instance, claimId, gitId, token, capture, change };
  }
  it('defaults to no protected grants, captures only selected IDs, and preserves timed metadata', () => {
    const h = fixture();
    const empty = captureLegacyDrainManifest(h.state.snapshot());
    expect(empty[0]?.resourceClaims).toEqual([]);
    expect(empty[0]?.gitRegistrations).toEqual([]);
    const registry = new LegacyDrainRegistry(h.runtime, h.capture(), { session: 600000, relay: 600000 });
    const revision = h.state.revision();
    expect(registry.resourceClaim(h.claimId, h.id, 1)).toBe(true);
    expect(registry.gitRegistration(h.gitId, h.id, 1)).toBe(true);
    expect(registry.resourceClaim(randomUUID(), h.id, 1)).toBe(false);
    expect(registry.resourceClaim(h.claimId, h.id, 2)).toBe(false);
    expect(registry.resourceClaim(h.claimId, randomUUID(), 1)).toBe(false);
    expect(registry.protectedDeadline(h.id, 1)).toBe(Date.now() + 45000);
    expect(legacyDrainDeadline(h.state.begin().view(), 'session', h.id))
      .toBe(registry.deadline(h.state.snapshot(), 'session', h.id));
    expect(registry.counts()).toMatchObject({ legacy_resource_claims: 1, legacy_git_registrations: 1 });
    expect(h.state.revision()).toEqual(revision);
    expect(h.state.snapshot().claims.get(h.claimId)?.ownershipMode).toBe('timed');
    registry.close();
  });
  it.each(['expired', 'uncertain', 'wrong-binding', 'wrong-instance'] as const)(
    'refuses %s candidates even when selected',
    (kind) => {
      const h = fixture();
      h.change((draft) => {
        const claim = draft.table('agentResourceClaims').get(h.claimId)!,
          git = draft.table('gitWorktrees').get(h.gitId)!;
        if (kind === 'expired') {
          draft.upsert('agentResourceClaims', {
            ...claim,
            expiresAt: new Date(Date.now() - 1).toISOString(),
          });
          draft.upsert('gitWorktrees', { ...git, expiresAt: new Date(Date.now() - 1).toISOString() });
        }
        if (kind === 'uncertain') {
          draft.upsert('agentResourceClaims', {
            ...claim,
            state: 'uncertain',
            uncertaintyReason: 'reported_unknown',
          });
          draft.upsert('gitWorktrees', { ...git, status: 'uncertain', uncertaintyReason: 'disconnected' });
        }
        if (kind === 'wrong-binding') {
          draft.upsert('agentResourceClaims', { ...claim, generation: 2 });
          draft.upsert('gitWorktrees', { ...git, agentBindingGeneration: 2 });
        }
        if (kind === 'wrong-instance') {
          draft.upsert('agentResourceClaims', { ...claim, nativeInstanceId: randomUUID() });
          draft.upsert('gitWorktrees', { ...git, nativeInstanceId: randomUUID() });
        }
      });
      const registry = new LegacyDrainRegistry(h.runtime, h.capture(), { session: 600000, relay: 600000 });
      expect(registry.resourceClaim(h.claimId, h.id, 1)).toBe(false);
      expect(registry.gitRegistration(h.gitId, h.id, 1)).toBe(false);
      registry.close();
    },
  );
  it.each(['instance', 'host-key', 'engine', 'session-end', 'scope-change', 'reported-unknown'] as const)(
    'revokes %s after capture',
    (kind) => {
      const h = fixture(),
        registry = new LegacyDrainRegistry(h.runtime, h.capture(), { session: 600000, relay: 600000 });
      h.change((draft) => {
        if (kind === 'instance')
          draft.upsert('agentNativeControls', {
            ...draft.table('agentNativeControls').get(h.id)!,
            instanceId: randomUUID(),
          });
        if (kind === 'host-key')
          draft.upsert('hosts', { ...h.state.snapshot().hosts.get(1)!, apiKeyHash: 'rotated' });
        if (kind === 'engine')
          draft.upsert('versions', {
            name: 'codex_engine_disabled',
            version: '1',
            updatedAt: new Date().toISOString(),
          });
        if (kind === 'session-end')
          draft.upsert('agentSessions', {
            ...h.state.snapshot().sessions.get(h.id)!,
            endedAt: new Date().toISOString(),
          });
        if (kind === 'scope-change') {
          draft.upsert('agentResourceClaims', {
            ...draft.table('agentResourceClaims').get(h.claimId)!,
            resources: [],
          });
          draft.upsert('gitWorktrees', {
            ...draft.table('gitWorktrees').get(h.gitId)!,
            worktreePath: '/elsewhere',
          });
        }
        if (kind === 'reported-unknown') {
          draft.upsert('agentResourceClaims', {
            ...draft.table('agentResourceClaims').get(h.claimId)!,
            state: 'uncertain',
            uncertaintyReason: 'reported_unknown',
          });
          draft.upsert('gitWorktrees', {
            ...draft.table('gitWorktrees').get(h.gitId)!,
            status: 'uncertain',
            uncertaintyReason: 'reported_unknown',
          });
        }
      });
      expect(registry.resourceClaim(h.claimId, h.id, 1)).toBe(false);
      expect(registry.gitRegistration(h.gitId, h.id, 1)).toBe(false);
      registry.close();
    },
  );
  it.each([false, true])(
    'does not widen original insecure security cap when the host window extends (restart=%s)',
    (restart) => {
      const h = fixture(),
        capturedAt = Date.now(),
        originalDeadline = capturedAt + 30000;
      h.change((draft) =>
        draft.upsert('hosts', {
          ...h.state.snapshot().hosts.get(1)!,
          secure: 0,
          insecureEnabledUntil: new Date(originalDeadline),
        }),
      );
      let registry = new LegacyDrainRegistry(h.runtime, h.capture(), { session: 600000, relay: 600000 });
      expect(registry.resourceClaim(h.claimId, h.id, 1)).toBe(true);
      h.change((draft) =>
        draft.upsert('hosts', {
          ...h.state.snapshot().hosts.get(1)!,
          insecureEnabledUntil: new Date(capturedAt + 120000),
        }),
      );
      if (restart) {
        registry.close();
        registry = new LegacyDrainRegistry(
          h.runtime,
          captureLegacyDrainManifest(h.state.snapshot(), Date.now(), {
            capturedAt,
            resourceClaimIds: [h.claimId],
            gitRegistrationIds: [h.gitId],
            securityDeadlines: { [h.id]: originalDeadline },
          }),
          { session: 600000, relay: 600000 },
        );
      }
      vi.advanceTimersByTime(20000);
      registry.renew('session', h.id, h.token, { instanceId: h.instance });
      expect(registry.protectedDeadline(h.id, 1)).toBe(originalDeadline);
      vi.advanceTimersByTime(10000);
      expect(registry.session(h.id, 1)).toBe(true);
      expect(registry.resourceClaim(h.claimId, h.id, 1)).toBe(false);
      expect(registry.gitRegistration(h.gitId, h.id, 1)).toBe(false);
      expect(registry.protectedDeadline(h.id, 1)).toBeNull();
      registry.close();
    },
  );
  it('accepts expired-at-boot TTL only with a valid earlier quiescent capture and fresh exact native proof', () => {
    const h = fixture(),
      capturedAt = Date.now();
    vi.advanceTimersByTime(70000);
    const ordinary = h.capture();
    expect(ordinary[0]?.resourceClaims).toEqual([]);
    const manifest = captureLegacyDrainManifest(h.state.snapshot(), Date.now(), {
      capturedAt,
      resourceClaimIds: [h.claimId],
      gitRegistrationIds: [h.gitId],
    });
    const registry = new LegacyDrainRegistry(h.runtime, manifest, { session: 600000, relay: 600000 });
    expect(registry.resourceClaim(h.claimId, h.id, 1)).toBe(false);
    registry.recover('session', h.id, h.token, 1, 'user', () => {});
    registry.renew('session', h.id, h.token, { instanceId: h.instance });
    expect(registry.resourceClaim(h.claimId, h.id, 1)).toBe(true);
    expect(registry.gitRegistration(h.gitId, h.id, 1)).toBe(true);
    registry.close();
  });
  it('requires fresh native observation, survives old heartbeat TTL and respects fixed session expiry', () => {
    const h = fixture(),
      registry = new LegacyDrainRegistry(h.runtime, h.capture(), { session: 600000, relay: 600000 });
    vi.advanceTimersByTime(45000);
    expect(registry.resourceClaim(h.claimId, h.id, 1)).toBe(false);
    registry.renew('session', h.id, h.token, { instanceId: h.instance });
    expect(registry.resourceClaim(h.claimId, h.id, 1)).toBe(true);
    vi.advanceTimersByTime(15000);
    expect(registry.resourceClaim(h.claimId, h.id, 1)).toBe(true);
    expect(registry.gitRegistration(h.gitId, h.id, 1)).toBe(true);
    registry.renew('session', h.id, h.token, { instanceId: h.instance });
    vi.advanceTimersByTime(30000);
    registry.renew('session', h.id, h.token, { instanceId: h.instance });
    vi.advanceTimersByTime(30000);
    expect(registry.resourceClaim(h.claimId, h.id, 1)).toBe(false);
    expect(registry.gitRegistration(h.gitId, h.id, 1)).toBe(false);
    expect(registry.protectedDeadline(h.id, 1)).toBeNull();
    registry.close();
  });
});

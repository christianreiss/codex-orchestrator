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
import { bindOwnerRuntime, mutateOwnerState, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { bindOwnerPresence, ConnectionPresence } from '../../../src/control-plane/presence.js';
import { registerOwnedReceiver, updateOwnedReceiver } from '../../../src/control-plane/streams/receiver.js';
import { registerOwnedRelay } from '../../../src/control-plane/streams/relay.js';
import { ownedAddressPresence, ownedDeliveryHintContext } from '../../../src/control-plane/state/presence-notices.js';
import { ownedHostInventory } from '../../../src/services/agent-messaging/owned-discovery.js';
import { deliveryReceiptFields } from '../../../src/services/agent-messaging/presence-feedback.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv } from '../../helpers/test-keyring.js';

const queues: DeadlineQueue[] = [];
afterEach(() => {
  queues.splice(0).forEach((q) => q.close());
  vi.useRealTimers();
});

/** The minimal owner runtime of daemon-owned.test.ts: one secure host with an accepting daemon for `user`. */
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
  const runtime: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: (command) => executor.execute(command) };
  bindOwnerRuntime(fake, runtime);
  const presence = new ConnectionPresence((e) => {
    throw e;
  });
  bindOwnerPresence(runtime, presence);
  const host = fake.tables.get(schema.hosts)![0] as typeof schema.hosts.$inferSelect;
  const context = (addressId: string) => {
    const snapshot = state.snapshot(),
      target = snapshot.addresses.get(addressId)!;
    return ownedDeliveryHintContext(runtime, snapshot, target, ownedAddressPresence(runtime, snapshot, target));
  };
  return { state, runtime, presence, host, env: loadTestEnv(), context };
}

function address(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    address: `agent:${id}`,
    hostId: 1,
    username: 'user',
    engine: 'codex',
    currentSessionId: null,
    bindingGeneration: 1,
    enabled: 1,
    archivedAt: null,
    readiness: 'offline',
    lastUpstreamSessionId: 'native-thread',
    ...extra,
  };
}

describe('owned send receipt diagnostics', () => {
  it('reports a missing daemon relay for an idle daemon helper until one attaches (feedback f4b31207)', async () => {
    const helper = randomUUID(),
      plain = randomUUID();
    const h = harness({
      agentBusAddresses: [address(helper), address(plain)],
      hostDaemonSessions: [{ id: randomUUID(), hostId: 1, addressId: helper, status: 'idle' }],
    });
    expect(ownedAddressPresence(h.runtime, h.state.snapshot(), h.state.snapshot().addresses.get(helper)!)).toBe(
      'resumable',
    );
    expect(h.context(helper)).toEqual({ daemonRelay: 'missing' });
    expect(deliveryReceiptFields('resumable', h.context(helper)).delivery_hint).toContain(
      'no daemon relay is connected',
    );
    // An address no daemon session serves keeps the plain offline receipt.
    expect(h.context(plain)).toEqual({});

    const instance = randomUUID();
    const registration = await registerOwnedRelay(h.runtime, h.host, {
      username: 'user:daemon',
      instanceId: instance,
      wrapperVersion: 'test',
      capabilities: { host_daemon: true, control_state_protocol: 1 },
    });
    // A registration row without a live attachment cannot resume anything.
    expect(h.context(helper)).toEqual({ daemonRelay: 'missing' });
    const attachment = h.presence.attach({
      connectionId: 'daemon-relay',
      hostId: 1,
      username: 'user:daemon',
      scope: {
        topic: 'relay',
        relay_id: String(registration.relay_id),
        native_instance_id: instance,
        binding_generation: Number(registration.generation),
      },
    });
    expect(h.context(helper)).toEqual({ daemonRelay: 'connected' });
    expect(deliveryReceiptFields('resumable', h.context(helper)).delivery_hint).toContain('may resume');
    attachment.detach();
    expect(h.context(helper)).toEqual({ daemonRelay: 'missing' });
  });

  it('names a long-closed claim gate and lists live connection and delivery evidence (feedback f2b100b0)', async () => {
    const id = randomUUID(),
      target = randomUUID(),
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
          engine: 'claude',
          username: 'user',
          agentBusAddressId: target,
          bindingGeneration: 1,
          endedAt: null,
          receiver: null,
        },
      ],
      agentBusAddresses: [address(target, { engine: 'claude', currentSessionId: id, lastUpstreamSessionId: null })],
    });
    h.presence.attach({
      connectionId: 'session',
      hostId: 1,
      username: 'user',
      scope: { topic: 'session', session_id: id, binding_generation: 1 },
    });
    await registerOwnedReceiver(h.runtime, h.env, id, token, {
      generation,
      protocol: 'claude-channel-v1',
      native_session_id: randomUUID(),
      capabilities: { claim_gate_v1: true },
    });
    h.presence.attach({
      connectionId: 'receiver',
      hostId: 1,
      username: 'user',
      scope: { topic: 'receiver', session_id: id, binding_generation: 1, receiver_generation: generation },
    });
    vi.useFakeTimers();
    await updateOwnedReceiver(h.runtime, id, token, generation, 'heartbeat', {
      claim_gate: { state: 'thread_other', seconds: 5 },
    });
    expect(ownedAddressPresence(h.runtime, h.state.snapshot(), h.state.snapshot().addresses.get(target)!)).toBe(
      'listening',
    );
    expect(deliveryReceiptFields('listening', h.context(target))).not.toHaveProperty('recipient_claim_gate');
    vi.setSystemTime(Date.now() + 130_000);
    const receipt = deliveryReceiptFields('listening', h.context(target));
    expect(receipt).toMatchObject({ recipient_claim_gate: 'thread_other', recipient_claim_gate_seconds: 135 });
    expect(receipt.delivery_hint).toContain('thread_other for 135s');

    const acceptedAt = new Date(Date.now() - 60_000).toISOString();
    await mutateOwnerState(h.runtime, {
      kind: 'fixture.accepted',
      payload: {},
      prepare(c) {
        for (const [at, session] of [
          [acceptedAt, id],
          [new Date(Date.now() - 120_000).toISOString(), id],
          [new Date().toISOString(), randomUUID()],
        ] as const)
          c.draft.upsert('agentBusMessages', {
            id: randomUUID(),
            targetAddressId: target,
            status: 'completed',
            deliverySessionId: session,
            acceptedAt: at,
          } as never);
        return null;
      },
    });
    const listed = ownedHostInventory(h.runtime, h.host).addresses[0]!.receiver as Record<string, unknown>;
    expect(listed).toMatchObject({
      ownership_mode: 'connection',
      claim_gate: 'thread_other',
      connection_observed_at: new Date().toISOString(),
      last_delivered_at: acceptedAt,
    });
    expect(typeof listed.connection_attached_at).toBe('string');
  });
});

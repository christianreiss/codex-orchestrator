import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '../../../../src/db/schema.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../../../../src/control-plane/state/store.js';
import { CommandExecutor } from '../../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../../src/control-plane/deadlines.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../../src/control-plane/presence.js';
import type { OwnerRuntime } from '../../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../../src/control-plane/persistence.js';
import type { StateSeed } from '../../../../src/control-plane/state/catalog.js';
import { prepareOwnedPresentations } from '../../../../src/services/agent-messaging/owned-presentations.js';
import { peerBatchTimingEligible } from '../../../../src/services/agent-messaging/peer-batch.js';
import { SERVER_ADDRESS_ID } from '../../../../src/services/agent-messaging/groups.js';
import { claimOwnedDelivery } from '../../../../src/services/agent-messaging/owned-claim.js';
import { newQueuedMessage } from '../../../../src/services/agent-messaging/views.js';
import { decrypt, encrypt } from '../../../../src/security/secret-box.js';
import { createDbFake } from '../../../helpers/db-fake.js';
import { testKeyring } from '../../../helpers/test-keyring.js';

const turn = vi.hoisted(() => ({ busy: false }));
vi.mock('../../../../src/control-plane/state/receiver-turn-proof.js', async (original) => ({
  ...(await original<typeof import('../../../../src/control-plane/state/receiver-turn-proof.js')>()),
  ownedClaudeTurnBusy: () => turn.busy,
}));

function fixture(engine: string, count = 2) {
  const sessionId = randomUUID(),
    instance = randomUUID(),
    generation = randomUUID();
  const target = {
    id: randomUUID(),
    engine,
    hostId: 1,
    enabled: 1,
    currentSessionId: sessionId,
    bindingGeneration: 1,
    archivedAt: null,
    adapterCapabilities: {},
  } as schema.AgentBusAddress;
  const sender = { ...target, id: randomUUID(), currentSessionId: null } as schema.AgentBusAddress;
  const now = new Date().toISOString(),
    keyring = testKeyring();
  const messages = Array.from({ length: count }, (_, i) => i + 1).map((order) => ({
    ...newQueuedMessage({
      id: randomUUID(),
      conversationId: randomUUID(),
      sequence: 1,
      sender,
      target,
      senderSessionId: null,
      kind: 'message',
      deliveryTiming: 'immediate',
      content: 'immediate information',
      contentEnc: encrypt('immediate information', keyring),
      clientMessageId: randomUUID(),
      expiresAt: '2099-01-01T00:00:00Z',
      now,
    }),
    dispatchOrder: order,
  }));
  const seed = {
    versions: [{ name: 'agent_messaging_enabled', version: '1' }],
    hosts: [{ id: 1, status: 'active', secure: 1, engines: engine }],
    agentBusAddresses: [sender, target],
    agentBusMessages: messages,
    agentSessions: [
      {
        id: sessionId,
        engine,
        hostId: 1,
        agentBusAddressId: target.id,
        bindingGeneration: 1,
        endedAt: null,
        receiver: { generation, delivery_timing_v1: true, heartbeat_at: now, probes: { peer: {} } },
      },
    ],
    agentNativeControls: [{ sessionId, instanceId: instance, bindingGeneration: 1, status: 'ready' }],
  } as unknown as StateSeed;
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed));
  const db = createDbFake(new Map<unknown, Record<string, unknown>[]>([[schema.agentBusMessages, messages]]));
  // Messages have a UUID key but MySQL's insertId is their numeric dispatch order.
  const insert = db.insert.bind(db);
  let dispatchOrder = count;
  vi.spyOn(db, 'insert').mockImplementation(table => {
    const builder = insert(table) as { values(input: Record<string, unknown> | Record<string, unknown>[]): Promise<unknown> };
    return table !== schema.agentBusMessages ? builder : {
      values: async (input: Record<string, unknown> | Record<string, unknown>[]) => {
        await builder.values(input);
        return [{ insertId: ++dispatchOrder }];
      },
    };
  });
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(error) {
      throw error;
    },
    notificationError(error) {
      throw error;
    },
    committed() {},
    persistence: {
      async receipt() {
        return undefined;
      },
      async record() {},
      async transaction(run) {
        await run(db as unknown as PersistenceTransaction);
      },
    },
  });
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  const runtime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  } as OwnerRuntime;
  const presence = new ConnectionPresence((error) => {
    throw error;
  });
  bindOwnerPresence(runtime, presence);
  presence.attach({
    connectionId: randomUUID(),
    hostId: 1,
    username: 'fixture',
    scope: { topic: 'session', session_id: sessionId, binding_generation: 1, native_instance_id: instance },
  });
  const receiver = presence.attach({
    connectionId: randomUUID(),
    hostId: 1,
    username: 'fixture',
    scope: {
      topic: 'receiver',
      session_id: sessionId,
      binding_generation: 1,
      receiver_generation: generation,
    },
  });
  const options = {
    targetAddressIds: [target.id],
    leaseOwner: `session:${sessionId}`,
    claimId: randomUUID(),
    relayGeneration: null,
    skipReceiveCapable: false,
    receiverGeneration: generation,
    informationalOnly: true,
    immediateOnly: true,
    deliveryTimingEnabled: true,
    smartQueue: false,
    peerBatch: false,
  };
  const claim = (claimId = randomUUID(), overrides: Partial<typeof options> = {}) =>
    claimOwnedDelivery(db as never, runtime, keyring, { ...options, ...overrides, claimId });
  return {
    state,
    runtime,
    db,
    keyring,
    messages: [...messages],
    claim,
    receiver,
    close: async () => {
      await executor.drain();
      deadlines.close();
    },
  };
}

it.each([59_999, 60_000, 60_001])('uses the exact stale threshold at %i milliseconds', age => {
  const now = Date.parse('2026-11-02T13:00:00Z');
  expect(peerBatchTimingEligible({ deliveryTiming: 'immediate', relatedWorkId: null,
    createdAt: new Date(now - age).toISOString() }, true, now)).toBe(age >= 60_000);
});

it('lets a Claude turn the owner still sees as busy take immediate information through an ordinary claim', async () => {
  const f = fixture('claude', 1);
  turn.busy = true;
  try {
    // The receiver's local gate is open, so it does not ask immediate-only.
    const delivery = await f.claim(randomUUID(), { immediateOnly: false, informationalOnly: false });
    expect(delivery?.message_id).toBe(f.messages[0]!.id);
    const draft = f.state.begin();
    draft.upsert('agentBusMessages', { ...f.state.snapshot().messages.get(f.messages[0]!.id)!, status: 'completed' });
    f.state.publish(draft.seal({ ...f.state.revision(), sequence: f.state.revision().sequence + 1n }));
  } finally {
    turn.busy = false;
    await f.close();
  }
});

describe.each(['codex', 'claude', 'grok'])('%s owned immediate admission', (engine) => {
  it('does not batch old immediate originals without peer-batch negotiation', async () => {
    const f = fixture(engine);
    try {
      const draft = f.state.begin();
      for (const row of draft.table('agentBusMessages').all()) draft.upsert('agentBusMessages', {
        ...row, createdAt: '2026-01-01T00:00:00Z',
      });
      f.state.publish(draft.seal({ ...f.state.revision(), sequence: f.state.revision().sequence + 1n }));
      await prepareOwnedPresentations(f.db as never, f.runtime, f.keyring,
        [f.messages[0]!.targetAddressId], { smart: true, peer: false, relay: false, includeStaleImmediate: true });
      expect(f.state.snapshot().messages.all().filter(row => row.kind === 'digest')).toHaveLength(0);
    } finally { await f.close(); }
  });
  it.each([
    ['fresh information', { createdAt: new Date().toISOString() }, true],
    ['missing timing capability', {}, false],
    ['causal work progress', { relatedWorkId: randomUUID() }, true],
    ['work requests', { kind: 'request', workKind: 'request' }, true],
    ['structured results', { taskResultStatus: 'succeeded' }, true],
    ['attempted originals', { attempts: 1 }, true],
    ['accepted originals', { status: 'accepted' }, true],
  ] as const)('does not batch %s', async (_name, changes, includeStaleImmediate) => {
    const f = fixture(engine);
    try {
      const draft = f.state.begin();
      for (const row of draft.table('agentBusMessages').all()) draft.upsert('agentBusMessages', {
        ...row, createdAt: '2026-01-01T00:00:00Z', ...changes,
      });
      f.state.publish(draft.seal({ ...f.state.revision(), sequence: f.state.revision().sequence + 1n }));
      await prepareOwnedPresentations(f.db as never, f.runtime, f.keyring,
        [f.messages[0]!.targetAddressId], { smart: true, peer: true, relay: false, includeStaleImmediate });
      expect(f.state.snapshot().messages.all().filter(row => row.kind === 'digest')).toHaveLength(0);
      for (const original of f.messages) expect(f.state.snapshot().messages.get(original.id)).toMatchObject({
        status: 'queued', ...changes,
      });
      expect(f.state.snapshot().messages.all().every(row => !row.digestId)).toBe(true);
    } finally { await f.close(); }
  });

  it('batches stale presence notices losslessly with peer progress at an ordinary drain', async () => {
    const f = fixture(engine, 9);
    try {
      const draft = f.state.begin();
      for (const [i, row] of draft.table('agentBusMessages').all().entries()) draft.upsert('agentBusMessages', {
        ...row, createdAt: '2026-01-01T00:00:00Z', deliveryTiming: 'after_turn',
        ...(i % 2 === 0 ? { kind: 'presence_notice', senderAddressId: SERVER_ADDRESS_ID } : {}),
      });
      f.state.publish(draft.seal({ ...f.state.revision(), sequence: f.state.revision().sequence + 1n }));
      await prepareOwnedPresentations(f.db as never, f.runtime, f.keyring,
        [f.messages[0]!.targetAddressId], { smart: true, peer: true, relay: false, includeStaleImmediate: true });
      const roots = f.state.snapshot().messages.all().filter(row => row.kind === 'digest');
      expect(roots).toHaveLength(1);
      for (const original of f.messages) expect(f.state.snapshot().messages.get(original.id)).toMatchObject({
        status: 'batched', digestId: roots[0]!.id, attempts: 0, acceptedAt: null,
      });
      const root = f.db.inserts.find(row => row.table === schema.agentBusMessages)!.values as schema.AgentBusMessage;
      const body = JSON.parse(decrypt(root.contentEnc, f.keyring));
      expect(body.total).toBe(9);
      expect(body.entries.map((entry: { message_id: string }) => entry.message_id)).toEqual(f.messages.map(row => row.id));
      expect(body.entries.filter((entry: { kind: string }) => entry.kind === 'presence_notice')).toHaveLength(5);
      expect(body.entries.every((entry: { content: string }) => entry.content === 'immediate information')).toBe(true);
    } finally { await f.close(); }
  });

  it('keeps stale information individually actionable in the active immediate lane', async () => {
    const f = fixture(engine);
    try {
      const draft = f.state.begin();
      for (const row of draft.table('agentBusMessages').all()) draft.upsert('agentBusMessages', {
        ...row, createdAt: '2026-01-01T00:00:00Z',
      });
      f.state.publish(draft.seal({ ...f.state.revision(), sequence: f.state.revision().sequence + 1n }));
      expect(await f.claim(randomUUID(), { peerBatch: true, smartQueue: true })).toMatchObject({
        kind: 'message', delivery_timing: 'immediate',
      });
      expect(f.state.snapshot().messages.all().filter(row => row.kind === 'digest')).toHaveLength(0);
    } finally { await f.close(); }
  });

  it('presents nine stale immediate originals together at an ordinary drain boundary', async () => {
    const f = fixture(engine, 9);
    try {
      const draft = f.state.begin();
      for (const row of draft.table('agentBusMessages').all()) draft.upsert('agentBusMessages', {
        ...row, createdAt: '2026-01-01T00:00:00Z',
      });
      f.state.publish(draft.seal({ ...f.state.revision(), sequence: f.state.revision().sequence + 1n }));
      await prepareOwnedPresentations(f.db as never, f.runtime, f.keyring,
        [f.messages[0]!.targetAddressId], { smart: true, peer: true, relay: false, includeStaleImmediate: true });
      const rows = f.state.snapshot().messages.all();
      const roots = rows.filter(row => row.kind === 'digest');
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatchObject({ status: 'queued', deliveryTiming: 'after_turn' });
      for (const original of f.messages) expect(f.state.snapshot().messages.get(original.id)).toMatchObject({
        status: 'batched', digestId: roots[0]!.id, deliveryTiming: 'immediate', attempts: 0, acceptedAt: null,
      });
      const root = (f.db.inserts.find(row => row.table === schema.agentBusMessages)!.values as schema.AgentBusMessage);
      const body = JSON.parse(decrypt(root.contentEnc, f.keyring));
      expect(body.presentation).toBe('peer_batch_v1');
      expect(body.total).toBe(9);
      expect(body.entries.map((entry: { message_id: string }) => entry.message_id)).toEqual(f.messages.map(row => row.id));
      expect(body.entries.every((entry: { content: string; delivery_timing: string }) => entry.content === 'immediate information' && entry.delivery_timing === 'immediate')).toBe(true);
    } finally { await f.close(); }
  });
  it.each(['batch', 'server_notice'] as const)('does not prepare unsupported immediate %s rows or create empty SQL commands', async kind => {
    const f = fixture(engine);
    try {
      const draft = f.state.begin();
      for (const row of draft.table('agentBusMessages').all()) draft.upsert('agentBusMessages', {
        ...row, createdAt: '2026-01-01T00:00:00Z',
        ...(kind === 'server_notice' ? { senderAddressId: SERVER_ADDRESS_ID, kind: 'publication' } : {}),
      });
      f.state.publish(draft.seal({ ...f.state.revision(), sequence: f.state.revision().sequence + 1n }));
      const execute = vi.spyOn(f.runtime, 'execute').mockRejectedValue(new Error('Unexpected presentation command'));
      const select = vi.spyOn(f.db, 'select'), sql = vi.spyOn(f.db, 'execute');
      await expect(prepareOwnedPresentations(f.db as never, f.runtime, testKeyring(),
        [f.messages[0]!.targetAddressId], { smart: true, peer: true, relay: false })).resolves.toBeUndefined();
      expect(execute).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); expect(sql).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it('serializes two dispatchers into exactly one outstanding immediate message', async () => {
    const f = fixture(engine);
    try {
      const deliveries = await Promise.all([f.claim(), f.claim()]);
      expect(deliveries.filter(Boolean)).toHaveLength(1);
      expect(deliveries.find(Boolean)?.delivery_timing).toBe('immediate');
      expect(
        f.state
          .snapshot()
          .messages.all()
          .filter((row) => row.status === 'leased'),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('returns empty subsequent claims entirely from owner RAM', async () => {
    const f = fixture(engine);
    try {
      await f.claim();
      const select = vi.spyOn(f.db, 'select'),
        execute = vi.spyOn(f.db, 'execute');
      for (let n = 0; n < 10; n++) expect(await f.claim()).toBeNull();
      expect(select).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
  it('refuses disclosure when the receiver connection disappears during the cold-body read', async () => {
    const f = fixture(engine);
    try {
      const select = f.db.select.bind(f.db);
      vi.spyOn(f.db, 'select').mockImplementation((fields) => {
        const result = select(fields);
        f.receiver.detach();
        return result;
      });
      await expect(f.claim()).rejects.toThrow();
      expect(
        f.state
          .snapshot()
          .messages.all()
          .every((row) => row.status === 'queued'),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
});

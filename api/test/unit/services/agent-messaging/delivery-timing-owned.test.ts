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
import { SERVER_ADDRESS_ID } from '../../../../src/services/agent-messaging/groups.js';
import { claimOwnedDelivery } from '../../../../src/services/agent-messaging/owned-claim.js';
import { newQueuedMessage } from '../../../../src/services/agent-messaging/views.js';
import { encrypt } from '../../../../src/security/secret-box.js';
import { createDbFake } from '../../../helpers/db-fake.js';
import { testKeyring } from '../../../helpers/test-keyring.js';

function fixture(engine: string) {
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
  const messages = [1, 2].map((order) => ({
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
  const claim = (claimId = randomUUID()) =>
    claimOwnedDelivery(db as never, runtime, keyring, { ...options, claimId });
  return {
    state,
    runtime,
    db,
    messages,
    claim,
    receiver,
    close: async () => {
      await executor.drain();
      deadlines.close();
    },
  };
}

describe.each(['codex', 'claude', 'grok'])('%s owned immediate admission', (engine) => {
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

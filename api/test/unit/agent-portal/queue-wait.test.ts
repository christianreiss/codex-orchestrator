import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { OwnerStateSnapshot, OwnerStateStore, type PreparedOwnerState } from '../../../src/control-plane/state/store.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { OwnedPortal } from '../../../src/services/agent-portal/owned.js';
import { recordMessagingRowChange } from '../../../src/control-plane/state/messaging-totals.js';
import {
  AGENT_PORTAL_MAX_WAITING_MESSAGES,
  AGENT_PORTAL_QUEUED_MESSAGE_TTL_SECONDS,
  type PortalActor,
} from '../../../src/services/agent-portal.js';
import { sha256 } from '../../../src/security/hash.js';
import { decrypt, encrypt } from '../../../src/security/secret-box.js';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
});

const token = 'fixture-bridge-token';
const operator: PortalActor = { kind: 'admin', user: { id: 7, displayName: 'Operator' } };

/** Owner runtime with one connected Codex session; `receiver` decides portal readiness. */
function fixture(options: { receiver?: Record<string, unknown> | null; receiverAttached?: boolean } = {}) {
  const id = randomUUID(),
    instance = randomUUID(),
    generation = randomUUID(),
    now = new Date().toISOString(),
    keyring = testKeyring();
  const receiver =
    options.receiver === null
      ? null
      : {
          generation,
          native_session_id: randomUUID(),
          protocol: 'codex-queue-v1',
          heartbeat_at: now,
          failure: null,
          probes: { portal: {} },
          ...options.receiver,
        };
  const seed = {
    versions: [{ name: 'agent_portal_enabled', version: '1' }],
    hosts: [{ id: 1, fqdn: 'fixture', status: 'active', secure: 1, engines: 'codex', apiKey: 'fixture-host' }],
    adminUsers: [{ id: 7, username: 'operator', name: 'Operator', active: 1, accessLevel: 'owner' }],
    agentSessions: [
      {
        id,
        hostId: 1,
        engine: 'codex',
        status: 'active',
        endedAt: null,
        expiresAt: null,
        closeRequestedAt: null,
        activeTurnId: null,
        bindingGeneration: 1,
        relayEnabled: receiver ? 1 : 0,
        bridgeTokenHash: sha256(token),
        hostAuthFingerprint: sha256('fixture-host'),
        bridgeExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        receiver,
      },
    ],
    agentNativeControls: [{ sessionId: id, instanceId: instance, bindingGeneration: 1, status: 'ready' }],
  } as unknown as StateSeed;
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed));
  const db = createDbFake(new Map());
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
      async reserve() {},
      async record() {},
      async transaction(run) {
        await run(db as unknown as PersistenceTransaction);
      },
    },
  });
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  const runtime = { state, deadlines, assertOwner() {}, execute: (c) => executor.execute(c) } as OwnerRuntime;
  const presence = new ConnectionPresence((error) => {
    throw error;
  });
  bindOwnerPresence(runtime, presence);
  const sessionAttachment = presence.attach({
    connectionId: randomUUID(),
    hostId: 1,
    username: 'fixture',
    scope: { topic: 'session', session_id: id, binding_generation: 1, native_instance_id: instance },
  });
  const attachReceiver = () =>
    presence.attach({
      connectionId: randomUUID(),
      hostId: 1,
      username: 'fixture',
      scope: { topic: 'receiver', session_id: id, binding_generation: 1, receiver_generation: generation },
    });
  if (options.receiverAttached) attachReceiver();
  cleanup.push(async () => {
    await executor.drain();
    deadlines.close();
    presence.close();
  });
  const portal = new OwnedPortal(runtime, db as unknown as Database, {} as Env, keyring);
  const send = (content = 'hello', kind: 'message' | 'answer' | 'close' = 'message', extra = {}) =>
    portal.enqueue(operator, { sessionId: id, clientMessageId: randomUUID(), content, ...extra }, kind) as Promise<
      Record<string, unknown>
    >;
  const events = () =>
    ((db.tables.get(schema.agentEvents) ?? []) as Array<{ eventType: string; clientEventId: string; payloadEnc: string }>).map(
      (row) => ({ type: row.eventType, id: row.clientEventId, payload: JSON.parse(decrypt(row.payloadEnc, keyring)) }),
    );
  const message = (messageId: string) => state.snapshot().table('agentMessages').by('messageId', messageId)[0];
  /** The db fake ignores select projections; expose the body under the claim's aliases. */
  const aliasBodies = () => {
    for (const row of (db.tables.get(schema.agentMessages) ?? []) as Array<Record<string, unknown>>) {
      row.content = row.contentEnc;
      row.metadata = row.metadataEnc;
    }
  };
  /** Insert a queued row directly, as if accepted long ago. */
  const seedQueued = (createdAt: string, content = 'old') => {
    const messageId = randomUUID(),
      rows = (db.tables.get(schema.agentMessages) ?? []) as Array<Record<string, unknown>>,
      row = {
        id: rows.length + 100,
        messageId,
        sessionId: id,
        portalUserId: null,
        adminUserId: 7,
        kind: 'message',
        promptId: null,
        clientMessageId: randomUUID(),
        contentEnc: encrypt(content, keyring),
        metadataEnc: encrypt('{}', keyring),
        status: 'queued',
        ownershipMode: 'connection',
        ownerInstanceId: null,
        ownerBindingGeneration: null,
        attempts: 0,
        nextAttemptAt: createdAt,
        leaseOwner: null,
        leaseUntil: null,
        upstreamId: null,
        lastError: null,
        acceptedAt: null,
        canceledAt: null,
        createdAt,
        updatedAt: createdAt,
      };
    rows.push(row);
    db.tables.set(schema.agentMessages, rows);
    const draft = state.begin();
    recordMessagingRowChange(draft, 'agentMessages', null, row as never);
    draft.upsert('agentMessages', row as never);
    state.publish(draft.seal({ ...state.revision(), sequence: state.revision().sequence + 1n }));
    return messageId;
  };
  const patchSession = (patch: Record<string, unknown>) => {
    const draft = state.begin();
    draft.upsert('agentSessions', { ...draft.table('agentSessions').get(id)!, ...patch } as never);
    state.publish(draft.seal({ ...state.revision(), sequence: state.revision().sequence + 1n }));
  };
  return {
    id,
    generation,
    portal,
    send,
    events,
    message,
    aliasBodies,
    seedQueued,
    patchSession,
    attachReceiver,
    sessionAttachment,
    claim: () => portal.claim(id, token, randomUUID(), 1, generation),
  };
}

describe('owned portal: messages wait for a connected receiver', () => {
  it('accepts a message while the receiver is connected but not ready and reports the wait', async () => {
    const f = fixture();
    const result = await f.send();
    expect(result).toMatchObject({ status: 'queued', kind: 'message', waiting_for_receiver: true });
    expect(f.message(String(result.message_id))).toMatchObject({ status: 'queued', attempts: 0 });
    expect(f.events().map((e) => e.type)).toEqual(['user_message']);
  });

  it('reports no wait when the receiver is ready, and delivers the held message once it is', async () => {
    const f = fixture();
    const held = await f.send('held');
    f.attachReceiver();
    expect(await f.send('direct')).toMatchObject({ waiting_for_receiver: false });
    f.aliasBodies();
    expect(await f.claim()).toMatchObject({ message_id: held.message_id, content: 'held', attempts: 1 });
  });

  it('still refuses when the native session presence is gone (lease lost)', async () => {
    const f = fixture();
    f.sessionAttachment.detach();
    await expect(f.send()).rejects.toMatchObject({ code: 'agent_message_lease_lost' });
  });

  it.each([
    ['a failed receiver', { failure: 'adapter_disconnected' }],
    ['a portal-closed receiver', { portal_closed: true, probes: {} }],
  ])('still refuses %s', async (_label, receiver) => {
    const f = fixture({ receiver });
    await expect(f.send()).rejects.toMatchObject({ code: 'agent_relay_not_ready' });
  });

  it('still refuses a session without receiver state whose relay is not open', async () => {
    const f = fixture({ receiver: null });
    await expect(f.send()).rejects.toMatchObject({ code: 'agent_relay_not_ready' });
  });

  it('keeps the strict readiness check for answers and close requests', async () => {
    const f = fixture();
    await expect(f.send('', 'close', { note: 'bye' })).rejects.toMatchObject({ code: 'agent_relay_not_ready' });
    await expect(f.send('', 'answer', { answer: 'yes', promptId: randomUUID() })).rejects.toMatchObject({
      code: 'agent_relay_not_ready',
    });
  });

  it(`refuses message ${AGENT_PORTAL_MAX_WAITING_MESSAGES + 1} with agent_queue_full while not ready`, async () => {
    const f = fixture();
    for (let i = 0; i < AGENT_PORTAL_MAX_WAITING_MESSAGES; i++) await f.send(`m${i}`);
    await expect(f.send('overflow')).rejects.toMatchObject({
      code: 'agent_queue_full',
      status: 409,
    });
    // Ready receivers keep the previous, uncapped behaviour.
    f.attachReceiver();
    await expect(f.send('ready')).resolves.toMatchObject({ waiting_for_receiver: false });
  });

  it('cancels a queued message older than the TTL at claim time and delivers the next one', async () => {
    const f = fixture({ receiverAttached: true });
    const stale = f.seedQueued(new Date(Date.now() - (AGENT_PORTAL_QUEUED_MESSAGE_TTL_SECONDS + 60) * 1000).toISOString());
    const fresh = f.seedQueued(new Date().toISOString(), 'fresh');
    f.aliasBodies();
    expect(await f.claim()).toMatchObject({ message_id: fresh, content: 'fresh' });
    expect(f.message(stale)).toMatchObject({ status: 'canceled', attempts: 0 });
    expect(f.events()).toContainEqual(
      expect.objectContaining({
        type: 'message_canceled',
        id: `server:message-dead:${stale}`,
        payload: expect.objectContaining({ message_id: stale, delivery_status: 'canceled' }),
      }),
    );
  });

  it('expired rows do not count toward the cap', async () => {
    const f = fixture();
    const old = new Date(Date.now() - (AGENT_PORTAL_QUEUED_MESSAGE_TTL_SECONDS + 60) * 1000).toISOString();
    const stale = Array.from({ length: AGENT_PORTAL_MAX_WAITING_MESSAGES }, () => f.seedQueued(old));
    await expect(f.send('after expiry')).resolves.toMatchObject({ waiting_for_receiver: true });
    for (const id of stale) expect(f.message(id)?.status).toBe('canceled');
  });

  it('lets the operator cancel a queued message, idempotently, with a non-attention event', async () => {
    const f = fixture();
    const sent = await f.send();
    const messageId = String(sent.message_id);
    await expect(f.portal.cancelMessage(operator, { sessionId: f.id, messageId })).resolves.toMatchObject({
      message_id: messageId,
      status: 'canceled',
      already_canceled: false,
    });
    await expect(f.portal.cancelMessage(operator, { sessionId: f.id, messageId })).resolves.toMatchObject({
      status: 'canceled',
      already_canceled: true,
    });
    const canceled = f.events().filter((e) => e.type === 'message_canceled');
    expect(canceled).toEqual([
      {
        type: 'message_canceled',
        id: `portal:message-cancel:${messageId}`,
        payload: expect.objectContaining({ message_id: messageId, delivery_status: 'canceled', canceled_by: 'operator' }),
      },
    ]);
    expect(f.events().some((e) => e.type === 'attention')).toBe(false);
    // A canceled message is never offered.
    f.attachReceiver();
    expect(await f.claim()).toBeNull();
  });

  it('refuses to cancel a leased message and reports its status', async () => {
    const f = fixture({ receiverAttached: true });
    const sent = await f.send();
    f.aliasBodies();
    expect(await f.claim()).toMatchObject({ message_id: sent.message_id });
    await expect(
      f.portal.cancelMessage(operator, { sessionId: f.id, messageId: String(sent.message_id) }),
    ).rejects.toMatchObject({ code: 'agent_message_not_cancelable', status: 409, extra: { status: 'leased', kind: 'message' } });
  });

  it('answers 404 for an unknown message or one from another session', async () => {
    const f = fixture(),
      other = fixture();
    const sent = await other.send();
    await expect(f.portal.cancelMessage(operator, { sessionId: f.id, messageId: randomUUID() })).rejects.toMatchObject({
      code: 'agent_message_not_found',
      status: 404,
    });
    await expect(
      f.portal.cancelMessage(operator, { sessionId: f.id, messageId: String(sent.message_id) }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

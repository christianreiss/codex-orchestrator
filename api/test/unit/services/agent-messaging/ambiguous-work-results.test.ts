import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../../src/db/client.js';
import type { AgentBusMessage } from '../../../../src/db/schema.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../../src/control-plane/state/store.js';
import type { OwnerMutationContext, OwnerRuntime } from '../../../../src/control-plane/state/runtime.js';
import type { StateSeed } from '../../../../src/control-plane/state/catalog.js';
import { DeadlineQueue } from '../../../../src/control-plane/deadlines.js';
import { stageOwnedTaskResult } from '../../../../src/services/agent-messaging/owned-delivery.js';
import { replyOwnedMessage } from '../../../../src/services/agent-messaging/owned-reply.js';
import { storeTaskResult, taskNotAcceptedError } from '../../../../src/services/agent-messaging/task-execution.js';
import { sha256 } from '../../../../src/security/hash.js';
import { createDbFake } from '../../../helpers/db-fake.js';
import { testKeyring } from '../../../helpers/test-keyring.js';

const now = '2026-11-10T12:00:00.000Z';
const result = { status: 'succeeded' as const, summary: 'Measured fixture outcome' };

function fixture(engine: string) {
  const sessionId = randomUUID(), senderId = randomUUID(), targetId = randomUUID();
  const token = 'fixture-bridge', hostKey = 'fixture-host';
  const message = {
    id: randomUUID(), claimId: randomUUID(), workKind: 'request', status: 'ambiguous',
    sourceEngine: engine, targetEngine: engine, acceptedAt: now, ambiguousAt: now,
    lastErrorCode: 'native_turn_interrupted', taskResultStatus: null,
    cancelRequestedAt: null, leaseOwner: `session:${sessionId}`,
    targetAddressId: targetId, senderAddressId: senderId, targetBindingGeneration: 1,
  } as AgentBusMessage;
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
    agentBusMessages: [message],
    versions: [{ name: 'agent_messaging_enabled', version: '1' }],
    hosts: [{ id: 1, apiKey: hostKey, status: 'active', secure: 1, engines: engine }],
    agentBusAddresses: [senderId, targetId].map(id => ({
      id, hostId: 1, engine, enabled: 1, archivedAt: null, bindingGeneration: 1,
      currentSessionId: id === targetId ? sessionId : null,
    })),
    agentSessions: [{
      id: sessionId, hostId: 1, engine, agentBusAddressId: targetId, bindingGeneration: 1,
      bridgeTokenHash: sha256(token), hostAuthFingerprint: sha256(hostKey),
      bridgeExpiresAt: '2099-01-01T00:00:00.000Z', endedAt: null,
    }],
  } as unknown as StateSeed));
  const write = vi.fn();
  const context = { draft: state.begin(), write } as unknown as OwnerMutationContext;
  const runtime: OwnerRuntime = {
    state,
    deadlines: new DeadlineQueue(error => { throw error; }),
    assertOwner() {},
    async execute(command) {
      command.authorize(state.snapshot());
      await command.prepare(state.snapshot(), state.revision());
      throw new Error('Rejected work must never reach persistence');
    },
  };
  return { message, context, write, state, runtime, sessionId, token, keyring: testKeyring() };
}

describe.each(['codex', 'claude', 'grok'])('%s ambiguous original-owner result reconciliation', (engine) => {
  it('refuses a new owned result despite retained original claim and acceptance, with actionable guidance', () => {
    const f = fixture(engine);
    expect(() => stageOwnedTaskResult(f.context, f.message, result, f.keyring, now)).toThrow(
      /ambiguous.*agent_message_get.*agent_send/,
    );
    expect(f.context.draft.table('agentTaskResults').by('messageId', f.message.id)).toEqual([]);
    expect(f.context.draft.table('agentBusMessages').get(f.message.id)).toEqual(f.message);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('keeps the SQL result path equally fenced without inserting or reopening work', async () => {
    const f = fixture(engine), db = createDbFake();
    await expect(storeTaskResult(db as unknown as Parameters<Parameters<Database['transaction']>[0]>[0],
      f.message, result, f.keyring, now)).rejects.toMatchObject({
      status: 409, code: 'agent_task_result_not_accepted', message: expect.stringMatching(/ambiguous.*agent_message_get.*agent_send/),
    });
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it.each(['progress', 'result', 'missing-claim', 'foreign-claim'])(
    'keeps the original session fenced for %s replies without changing the message', async (kind) => {
      const f = fixture(engine), db = createDbFake();
      const before = f.state.snapshot();
      await expect(replyOwnedMessage(db as unknown as Database, f.runtime, f.keyring,
        { kind: 'session', id: f.sessionId, token: f.token }, f.message.id, {
          clientMessageId: randomUUID(), content: 'Measured fixture outcome',
          ...(kind === 'missing-claim' ? {} : { claimId: kind === 'foreign-claim' ? randomUUID() : f.message.claimId! }),
          ...(kind === 'result' ? { taskResult: result } : { queue: { delivery_class: 'progress' } }),
        })).rejects.toMatchObject(kind === 'foreign-claim'
          ? { code: 'agent_messaging_lease_lost' }
          : { code: 'agent_task_result_not_accepted', message: expect.stringMatching(/ambiguous.*agent_message_get.*agent_send/) });
      expect(f.state.snapshot()).toBe(before);
      expect(db.inserts).toEqual([]);
      expect(db.updates).toEqual([]);
    },
  );

  it('preserves the separate cancellation receipt exception and immutable receipt retries', () => {
    const f = fixture(engine);
    f.message.cancelRequestedAt = now;
    expect(taskNotAcceptedError(f.message, 'Progress requires accepted work').message)
      .toBe('Progress requires accepted work');
    f.context.draft.upsert('agentBusMessages', f.message);
    expect(stageOwnedTaskResult(f.context, f.message, result, f.keyring, now)).toEqual(result);
    const writes = f.write.mock.calls.length;
    expect(stageOwnedTaskResult(f.context, f.message, result, f.keyring, now)).toEqual(result);
    expect(f.write).toHaveBeenCalledTimes(writes);
    expect(f.context.draft.table('agentBusMessages').get(f.message.id)?.status).toBe('ambiguous');
    expect(() => stageOwnedTaskResult(f.context, f.message, { ...result, status: 'failed' }, f.keyring, now))
      .toThrow('A different result already exists');
  });
});

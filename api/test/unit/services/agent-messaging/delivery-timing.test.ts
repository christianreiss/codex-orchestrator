import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  queuePolicy,
  captureQueuePolicy,
  deliveryTimingReceipt,
  assertQueuePolicyReplay,
} from '../../../../src/services/agent-messaging/smart-queue.js';
import {
  ownedClaimCandidates,
  type OwnedClaimOptions,
} from '../../../../src/services/agent-messaging/owned-claim.js';
import { OwnerStateSnapshot } from '../../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../../src/control-plane/state/catalog.js';
import type { AgentBusMessage } from '../../../../src/db/schema.js';

describe('explicit message delivery timing', () => {
  it('defaults to after_turn independently of delivery class', () => {
    expect(queuePolicy(undefined)).toMatchObject({ deliveryTiming: 'after_turn' });
    expect(queuePolicy({ delivery_class: 'coordination' })).toMatchObject({ deliveryTiming: 'after_turn' });
    expect(
      queuePolicy({ delivery_timing: 'immediate', delivery_class: 'information' } as never),
    ).toMatchObject({ deliveryTiming: 'immediate', deliveryClass: 'information' });
  });
  it('captures immutable policy and preserves the legacy default replay shape', () => {
    expect(captureQueuePolicy({ delivery_timing: 'after_turn' })).toBeUndefined();
    const supplied = { delivery_timing: 'immediate' as 'immediate' | 'after_turn' };
    const captured = captureQueuePolicy(supplied);
    supplied.delivery_timing = 'after_turn';
    expect(captured?.delivery_timing).toBe('immediate');
    expect(deliveryTimingReceipt('immediate', false)).toEqual({
      requested_delivery_timing: 'immediate',
      effective_delivery_timing: null,
      timing_fallback_reason: 'receiver_capability_missing',
    });
    expect(deliveryTimingReceipt('immediate', true)).toMatchObject({
      effective_delivery_timing: 'immediate',
    });
  });
  it('keeps coordination priority within the immediate lane independently of deferred rows', () => {
    const target = randomUUID(),
      now = '2026-10-25T12:00:00Z';
    const row = (order: number, timing: string, deliveryClass: string) => ({
      id: randomUUID(),
      targetAddressId: target,
      kind: 'message',
      workKind: null,
      deliveryTiming: timing,
      deliveryClass,
      status: 'queued',
      dispatchOrder: order,
      conversationId: randomUUID(),
      expiresAt: '2099-01-01T00:00:00Z',
      nextAttemptAt: now,
    });
    const deferred = row(1, 'after_turn', 'coordination'),
      ordinary = row(2, 'immediate', 'information');
    const coordination = row(3, 'immediate', 'coordination');
    const snapshot = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      agentBusMessages: [deferred, ordinary, coordination],
    } as unknown as StateSeed);
    const options = {
      targetAddressIds: [target],
      leaseOwner: `session:${randomUUID()}`,
      relayGeneration: null,
      smartQueue: true,
      informationalOnly: true,
      immediateOnly: true,
      deliveryTimingEnabled: true,
    } as OwnedClaimOptions;
    expect(ownedClaimCandidates(snapshot, options, now).map((message) => message.id)).toEqual([
      coordination.id,
    ]);
  });
  it('rejects immediate work and conflicting UUID policy replay', () => {
    expect(() => queuePolicy({ delivery_timing: 'immediate' } as never, true)).toThrow();
    expect(() =>
      assertQueuePolicyReplay(
        { deliveryClass: 'information', deliveryTiming: 'after_turn' } as AgentBusMessage,
        queuePolicy({ delivery_timing: 'immediate' } as never),
      ),
    ).toThrow();
  });
  it('admits one immediate informational message alongside held work without admitting more work', () => {
    const targetId = randomUUID(),
      now = '2026-10-25T12:00:00Z';
    const message = (order: number, patch: Record<string, unknown>) => ({
      id: randomUUID(),
      conversationId: randomUUID(),
      targetAddressId: targetId,
      status: 'queued',
      kind: 'message',
      deliveryTiming: 'immediate',
      workKind: null,
      deliveryClass: 'information',
      relatedWorkId: null as string | null,
      acceptedAt: null as string | null,
      dispatchOrder: order,
      expiresAt: '2099-01-01T00:00:00Z',
      nextAttemptAt: now,
      ...patch,
    });
    const work = message(1, {
      status: 'accepted',
      kind: 'task',
      workKind: 'task',
      deliveryTiming: 'after_turn',
    });
    const normal = message(2, { deliveryTiming: 'after_turn' });
    const immediate = message(3, {}),
      maliciousWork = message(4, { kind: 'task', workKind: 'task' });
    const options = {
      targetAddressIds: [targetId],
      leaseOwner: `session:${randomUUID()}`,
      relayGeneration: null,
      smartQueue: false,
      informationalOnly: true,
      immediateOnly: true,
      deliveryTimingEnabled: true,
    } as OwnedClaimOptions;
    const snapshot = (held = false) =>
      new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
        agentBusMessages: [
          work,
          normal,
          { ...immediate, ...(held ? { status: 'leased' } : {}) },
          maliciousWork,
        ],
      } as unknown as StateSeed);
    expect(ownedClaimCandidates(snapshot(), options, now).map((row) => row.id)).toEqual([immediate.id]);
    expect(ownedClaimCandidates(snapshot(true), options, now)).toEqual([]);
    immediate.relatedWorkId = work.id;
    expect(ownedClaimCandidates(snapshot(), options, now)).toEqual([]);
    work.acceptedAt = now;
    expect(ownedClaimCandidates(snapshot(), options, now).map((row) => row.id)).toEqual([immediate.id]);
  });
});

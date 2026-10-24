import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OwnerStateSnapshot, OwnerStateDraft } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { pruneDomainHistory } from '../../../src/control-plane/state/working-history.js';

describe('bounded owner history projections', () => {
  it('evicts settled feedback but retains every unfinished publication and unknown work', () => {
    const snapshot = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      feedbackItems: ['settled', 'retry', 'uncertain', 'open'].map((id) => ({
        id,
        status: id === 'open' ? 'open' : 'resolved',
      })),
      feedbackPipeline: [
        { feedbackId: 'settled', deliveryState: 'sent', nextAttemptAt: null, leaseToken: null },
        { feedbackId: 'retry', deliveryState: 'local', nextAttemptAt: '2099-01-01', leaseToken: null },
        { feedbackId: 'uncertain', deliveryState: 'uncertain', nextAttemptAt: null, leaseToken: null },
      ],
    } as unknown as StateSeed);
    const draft = new OwnerStateDraft(snapshot);
    pruneDomainHistory(draft, true);
    expect(
      draft
        .table('feedbackItems')
        .all()
        .map((row) => row.id)
        .sort(),
    ).toEqual(['open', 'retry', 'uncertain']);
    expect(draft.table('feedbackPipeline').has('settled')).toBe(false);
  });
  it('keeps one latest history row per working schedule/address and never discards accepted uncertainty', () => {
    const rows = Array.from({ length: 100 }, (_, n) => ({
      id: String(n).padStart(3, '0'),
      createdAt: '2026-10-24',
      status: 'completed',
    }));
    const snapshot = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      agentSchedules: rows
        .map((row) => ({ id: row.id, deletedAt: null }))
        .concat([{ id: 'accepted', deletedAt: null }]),
      agentWatchdogs: rows
        .map((row) => ({ ...row, targetAddressId: 'address', scheduleId: row.id }))
        .concat([
          {
            id: 'accepted',
            createdAt: '2026-10-23',
            status: 'completed',
            targetAddressId: 'address',
            scheduleId: 'accepted',
          },
        ]),
      agentScheduleRuns: rows
        .map((row) => ({ ...row, scheduleId: row.id }))
        .concat([{ id: 'accepted', createdAt: '2026-10-23', status: 'accepted', scheduleId: 'accepted' }]),
    } as unknown as StateSeed);
    const draft = new OwnerStateDraft(snapshot);
    pruneDomainHistory(draft, true);
    expect(
      draft
        .table('agentWatchdogs')
        .all()
        .map((row) => row.id)
        .sort(),
    ).toEqual(['099', 'accepted']);
    expect(
      draft
        .table('agentSchedules')
        .all()
        .map((row) => row.id)
        .sort(),
    ).toEqual(['099', 'accepted']);
    expect(
      draft
        .table('agentScheduleRuns')
        .all()
        .map((row) => row.id)
        .sort(),
    ).toEqual(['099', 'accepted']);
  });
});

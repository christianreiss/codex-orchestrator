import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OwnerWorkerOptions } from '../../../src/ops/owner-worker.js';
import { EntityView, OwnerStateSnapshot } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';

const captured = vi.hoisted(() => ({ worker: undefined as OwnerWorkerOptions | undefined }));
vi.mock('../../../src/ops/owner-worker.js', () => ({
  startOwnerWorker: (_app: unknown, _db: unknown, worker: OwnerWorkerOptions) => { captured.worker = worker; },
}));
vi.mock('../../../src/ops/owner-maintenance.js', () => ({
  requireOwnerMaintenanceCommands: () => ({ facts: { revision: () => '1' } }),
}));
import { startQuotaWorker } from '../../../src/ops/quota-worker.js';

describe('quota notice selection', () => {
  it('selects active bound accounts without reading retained session history', () => {
    const base = { providerAccountId: 1, agentBusAddressId: 'address', status: 'active', endedAt: null };
    const snapshot = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      agentSessions: [
        { ...base, id: 'live' },
        { ...base, id: 'ended-active', endedAt: '2026-10-01T00:00:00Z' },
        { ...base, id: 'unassigned', providerAccountId: null },
        { ...base, id: 'unbound', agentBusAddressId: null },
        ...Array.from({ length: 100 }, (_, i) => ({ ...base, id: `history-${i}`, status: 'ended' })),
      ],
    } as unknown as StateSeed);
    const all = vi.spyOn(EntityView.prototype, 'all').mockImplementation(() => { throw new Error('retained history traversal'); });
    startQuotaWorker({} as never, {} as never, {} as never, {} as never);
    expect(captured.worker?.select(snapshot, Date.now()).map(work => work.key)).toEqual(['live']);
    all.mockRestore();
  });
});

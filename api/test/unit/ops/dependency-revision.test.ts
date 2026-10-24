import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { dependencyRevision } from '../../../src/ops/schedule-obligations.js';
import { EntityView, OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { OWNED_TABLE_NAMES } from '../../../src/control-plane/state/catalog.js';

const fresh = () => new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n });
describe('owner obligation dependency revisions', () => {
  it('uses view identity without reading, cloning or serializing table rows', () => {
    const snapshot = fresh();
    const all = vi.spyOn(EntityView.prototype, 'all').mockImplementation(() => {
      throw new Error('Dependency revisions must never traverse rows');
    });
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const first = dependencyRevision(snapshot, OWNED_TABLE_NAMES);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      for (let i = 0; i < 100; i++) expect(dependencyRevision(snapshot, OWNED_TABLE_NAMES)).toBe(first);
      expect(all).not.toHaveBeenCalled();
      expect(clone).not.toHaveBeenCalled();
    } finally {
      all.mockRestore();
      clone.mockRestore();
    }
  });
  it('changes on inserts, updates and deletes but not unrelated commits', () => {
    const state = new OwnerStateStore(fresh());
    const originalHosts = dependencyRevision(state.snapshot(), ['hosts']);
    const revisions = [dependencyRevision(state.snapshot(), ['versions'])];
    for (const value of ['one', 'two', null]) {
      const draft = state.begin();
      if (value === null) draft.remove('versions', 'test');
      else draft.upsert('versions', { name: 'test', version: value, updatedAt: new Date().toISOString() });
      state.publish(draft.seal({ ...state.revision(), sequence: state.revision().sequence + 1n }));
      revisions.push(dependencyRevision(state.snapshot(), ['versions']));
      expect(dependencyRevision(state.snapshot(), ['hosts'])).toBe(originalHosts);
    }
    expect(new Set(revisions).size).toBe(4);
  });
  it('conservatively invalidates every replaced table even when its contents are identical', () => {
    const snapshot = fresh();
    for (const name of OWNED_TABLE_NAMES) {
      const next = new OwnerStateSnapshot({ ...snapshot.revision, sequence: 1n }, {}, snapshot, new Set([name]));
      expect(dependencyRevision(next, [name])).not.toBe(dependencyRevision(snapshot, [name]));
    }
  });
  it('separates owner epochs even with identical shared views and empty dependencies', () => {
    const snapshot = fresh();
    const restarted = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {}, snapshot, new Set());
    expect(restarted.table('versions')).toBe(snapshot.table('versions'));
    expect(dependencyRevision(restarted, ['versions'])).not.toBe(dependencyRevision(snapshot, ['versions']));
    expect(dependencyRevision(restarted, [])).not.toBe(dependencyRevision(snapshot, []));
    const next = new OwnerStateSnapshot({ ...snapshot.revision, sequence: 1n }, {}, snapshot, new Set());
    expect(dependencyRevision(next, ['versions'])).toBe(dependencyRevision(snapshot, ['versions']));
  });
});

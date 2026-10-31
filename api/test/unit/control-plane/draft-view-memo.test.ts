import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';

const now = '2026-10-31T20:00:00.000Z';
const version = (name: string, value: string) => ({ name, version: value, updatedAt: now });
const store = () =>
  new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      versions: [version('a', '1'), version('b', '1')],
    } as never),
  );

describe('OwnerStateDraft read memoization', () => {
  it('returns the same view and table between writes and a fresh one after every kind of write', () => {
    const draft = store().begin();
    // Nothing staged yet: views are the base snapshot's own.
    expect(draft.table('versions')).toBe(draft.base.table('versions'));

    draft.upsert('versions', version('c', '1'));
    const view1 = draft.view();
    const table1 = draft.table('versions');
    expect(draft.view()).toBe(view1);
    expect(draft.table('versions')).toBe(table1);
    expect(table1.get('c')).toBeDefined();

    draft.upsert('versions', version('c', '2'));
    const view2 = draft.view();
    expect(view2).not.toBe(view1);
    expect(draft.table('versions')).not.toBe(table1);
    expect(draft.table('versions').get('c')?.version).toBe('2');
    // Earlier reads are immutable snapshots of their moment, never rewritten.
    expect(view1.table('versions').get('c')?.version).toBe('1');
    expect(table1.get('c')?.version).toBe('1');

    draft.remove('versions', 'c');
    expect(draft.view()).not.toBe(view2);
    expect(draft.table('versions').get('c')).toBeUndefined();
    expect(view2.table('versions').get('c')?.version).toBe('2');

    const afterRemove = draft.view();
    draft.removeRow('versions', draft.table('versions').get('a')!);
    expect(draft.view()).not.toBe(afterRemove);
    expect(draft.table('versions').get('a')).toBeUndefined();
  });
  it('invalidates the view when only messaging totals change', () => {
    const draft = store().begin();
    draft.upsert('versions', version('c', '1'));
    const before = draft.view();
    draft.adjustMessagingTotals({ bus: [{ sourceEngine: 'claude', targetEngine: 'codex', status: 'queued', count: 1 }] });
    const after = draft.view();
    expect(after).not.toBe(before);
    expect(after.messagingTotals).not.toEqual(before.messagingTotals);
  });
  it('rebuilds a table view only when that table is written', () => {
    const draft = store().begin();
    draft.upsert('versions', version('c', '1'));
    const versions = draft.table('versions');
    draft.upsert('hosts', { id: 1, fqdn: 'h' } as never);
    expect(draft.table('versions')).toBe(versions);
  });
  it('makes a reconcile-shaped loop cost one rebuild per write, not one per row', () => {
    const draft = store().begin();
    for (let i = 0; i < 300; i++) draft.upsert('versions', version(`row${i}`, '0'));
    const seen = new Set<OwnerStateSnapshot>();
    for (const row of draft.table('versions').all()) {
      seen.add(draft.view());
      if (row.name.endsWith('7')) draft.upsert('versions', { ...row, version: '1' });
    }
    // 300 reads but only ~30 writes: one distinct snapshot per write, plus the initial one.
    expect(seen.size).toBeLessThanOrEqual(31);
    expect(seen.size).toBeGreaterThan(1);
  });
  it('seals exactly the staged state after cached reads', () => {
    const s = store();
    const draft = s.begin();
    draft.upsert('versions', version('c', '1'));
    draft.view();
    draft.upsert('versions', version('d', '1'));
    draft.view();
    s.publish(draft.seal({ ...s.revision(), sequence: s.revision().sequence + 1n }));
    const names = s
      .snapshot()
      .table('versions')
      .all()
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(['a', 'b', 'c', 'd']);
  });
});

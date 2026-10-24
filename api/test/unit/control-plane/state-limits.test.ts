import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import type { StateRow } from '../../../src/control-plane/state/catalog.js';
const epoch = randomUUID(),
  initial = { epoch, sequence: 0n };
const setting = (name: string, version = '1') => ({ name, version, updatedAt: '2026-10-24T00:00:00Z' });
const next = (store: OwnerStateStore) => ({ epoch, sequence: store.revision().sequence + 1n });
describe('runtime owner metadata limits', () => {
  it('rejects per-table overflow without publishing or evicting existing obligations', () => {
    const store = new OwnerStateStore(new OwnerStateSnapshot(initial, { versions: [setting('a')] }), {
      rowsPerTable: 1,
    });
    const before = store.snapshot(),
      draft = store.begin();
    draft.upsert('versions', setting('b'));
    const prepared = draft.seal(next(store));
    expect(() => store.validate(prepared)).toThrow('row limit for versions');
    expect(() => store.publish(prepared)).toThrow('row limit for versions');
    expect(store.snapshot()).toBe(before);
    expect(store.snapshot().settings.get('a')).toBeDefined();
    expect(store.snapshot().settings.get('b')).toBeUndefined();
    const replacement = store.begin();
    replacement.remove('versions', 'a');
    replacement.upsert('versions', setting('b'));
    store.publish(replacement.seal(next(store)));
    expect(store.snapshot().settings.get('b')).toBeDefined();
  });
  it('counts total rows across tables and derived aggregates', () => {
    const store = new OwnerStateStore(new OwnerStateSnapshot(initial, { versions: [setting('a')] }), {
      totalRows: 1,
    });
    const draft = store.begin();
    draft.upsert('providerAccounts', {
      id: 1,
      engine: 'codex',
      state: 'enabled',
    } as StateRow<'providerAccounts'>);
    expect(() => store.validate(draft.seal(next(store)))).toThrow('total row limit');
    const aggregate = store.begin();
    aggregate.adjustMessagingTotals({ responses: [{ engine: 'codex', count: 1 }] });
    expect(() => store.validate(aggregate.seal(next(store)))).toThrow('total row limit');
    const removal = store.begin();
    removal.remove('versions', 'a');
    removal.adjustMessagingTotals({ responses: [{ engine: 'codex', count: 1 }] });
    store.publish(removal.seal(next(store)));
    expect(store.snapshot().metadataUsage.rows).toBe(1);
  });
  it('measures UTF8 projected metadata updates and credits removals exactly', () => {
    const snapshot = new OwnerStateSnapshot(initial, { versions: [setting('a', 'a')] });
    const store = new OwnerStateStore(snapshot, { metadataBytes: snapshot.metadataUsage.metadataBytes });
    const draft = store.begin();
    draft.upsert('versions', setting('a', '🙂'));
    expect(draft.view().metadataUsage.metadataBytes - snapshot.metadataUsage.metadataBytes).toBe(3);
    expect(() => store.validate(draft.seal(next(store)))).toThrow('metadata byte limit');
    const replacement = store.begin();
    replacement.remove('versions', 'a');
    replacement.upsert('versions', setting('b', 'b'));
    store.publish(replacement.seal(next(store)));
    expect(store.snapshot().metadataUsage.metadataBytes).toBe(snapshot.metadataUsage.metadataBytes);
    const removed = store.begin();
    removed.remove('versions', 'b');
    store.publish(removed.seal(next(store)));
    expect(store.snapshot().metadataUsage.metadataBytes).toBe(
      new OwnerStateSnapshot(initial).metadataUsage.metadataBytes,
    );
  });
  it('does not charge cold bodies and reuses unchanged row measurements', () => {
    const snapshot = new OwnerStateSnapshot(initial, {
      versions: [setting('untouched'), setting('changed')],
    });
    const store = new OwnerStateStore(snapshot),
      draft = store.begin();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      draft.upsert('versions', setting('changed', '2'));
      store.publish(draft.seal(next(store)));
      expect(
        stringify.mock.calls.some(
          ([value]) => value && typeof value === 'object' && 'name' in value && value.name === 'untouched',
        ),
      ).toBe(false);
    } finally {
      stringify.mockRestore();
    }
    const payload = { id: 1, engine: 'codex', body: 'a' } as unknown as StateRow<'authPayloads'>;
    const small = new OwnerStateSnapshot(initial, { authPayloads: [payload] });
    const large = new OwnerStateSnapshot(initial, {
      authPayloads: [{ ...payload, body: 'a'.repeat(100_000) } as unknown as StateRow<'authPayloads'>],
    });
    expect(small.metadataUsage).toEqual(large.metadataUsage);
  });
  it('validates initial state and limit values', () => {
    const snapshot = new OwnerStateSnapshot(initial, { versions: [setting('a'), setting('b')] });
    expect(() => new OwnerStateStore(snapshot, { rowsPerTable: 1 })).toThrow('row limit');
    expect(() => new OwnerStateStore(snapshot, { totalRows: 0 })).toThrow('Invalid owner state limit');
  });
});

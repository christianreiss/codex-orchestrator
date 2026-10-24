import { describe, expect, it, vi } from 'vitest';
import { OwnerStateStore, OwnerStateSnapshot, wireStateRevision } from '../src/control-plane/state/store.js';
import {
  assertSchemaCoverage,
  isColdField,
  OWNED_TABLE_NAMES,
  stateColumns,
  stateKeyFields,
  type StateRow,
} from '../src/control-plane/state/catalog.js';
import { hydrateOwnerState } from '../src/control-plane/state/hydrate.js';
import type { Database } from '../src/db/client.js';
const epoch = '12345678-1234-1234-1234-123456789012';
const initial = { epoch, sequence: 0n };
const setting = (name: string, version: string) => ({ name, version, updatedAt: '2026-10-24T00:00:00Z' });
function hydrationDb(rows: unknown[] = []) {
  const limit = vi.fn(async () => rows);
  class Query {
    limit = limit;
    groupBy() {
      return this;
    }
    where() {
      return this;
    }
    orderBy() {
      return this;
    }
    innerJoin() {
      return this;
    }
    then(resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(rows).then(resolve, reject);
    }
  }
  const select = vi.fn(() => ({ from: () => new Query() }));
  return { db: { select } as unknown as Pick<Database, 'select'>, select, limit };
}
describe('authoritative owner state', () => {
  it('reads deeply immutable metadata without cloning it again', () => {
    const snapshot = new OwnerStateSnapshot(initial, { versions: [setting('api_disabled', '0')] });
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const row = snapshot.settings.get('api_disabled')!;
      for (let i = 0; i < 20; i++) {
        expect(snapshot.settings.get('api_disabled')).toBe(row);
        expect(snapshot.settings.by('name', 'api_disabled')[0]).toBe(row);
        expect(snapshot.settings.all()[0]).toBe(row);
      }
      expect(clone).not.toHaveBeenCalled();
      expect(() => { (row as { version: string }).version = 'changed'; }).toThrow();
    } finally {
      clone.mockRestore();
    }
  });

  it('keeps mutable metadata leaves isolated in indexed and whole-table reads', () => {
    const snapshot = new OwnerStateSnapshot(initial, {
      agentBusAddresses: [{
        id: 'address', hostId: 1,
        adapterCapabilities: { bytes: new Uint8Array([1, 2]), date: new Date(123) },
      } as unknown as StateRow<'agentBusAddresses'>],
    });
    const table = snapshot.addresses;
    for (const rows of [table.by('hostId', 1), table.all()]) {
      const metadata = rows[0]!.adapterCapabilities as { bytes: Uint8Array; date: Date };
      metadata.bytes[0] = 9;
      metadata.date.setTime(999);
      const current = table.get('address')!.adapterCapabilities as { bytes: Uint8Array; date: Date };
      expect(current.bytes[0]).toBe(1);
      expect(current.date.getTime()).toBe(123);
    }
  });

  it('classifies every schema table and never selects payloads', () => {
    assertSchemaCoverage();
    for (const name of OWNED_TABLE_NAMES) {
      expect(stateKeyFields(name).length).toBeGreaterThan(0);
      expect(Object.keys(stateColumns(name)).some(isColdField)).toBe(false);
    }
  });
  it('publishes multi-domain changes atomically while old snapshots remain stable', () => {
    const store = new OwnerStateStore(
      new OwnerStateSnapshot(initial, { versions: [setting('api_disabled', '0')] }),
    );
    const before = store.snapshot();
    const draft = store.begin();
    draft.upsert('versions', setting('api_disabled', '1'));
    draft.upsert('providerAccounts', {
      id: 42,
      engine: 'codex',
      state: 'disabled',
    } as StateRow<'providerAccounts'>);
    const prepared = draft.seal({ epoch, sequence: 1n });
    store.validate(prepared);
    expect(() => draft.upsert('versions', setting('api_disabled', '0'))).toThrow('sealed');
    expect(() => draft.remove('versions', 'api_disabled')).toThrow('sealed');
    expect(store.snapshot().setting('api_disabled')).toBe('0');
    expect(store.snapshot().accounts.get(42)).toBeUndefined();
    store.publish(prepared);
    expect(store.snapshot().setting('api_disabled')).toBe('1');
    expect(store.snapshot().accounts.get(42)?.state).toBe('disabled');
    expect(before.setting('api_disabled')).toBe('0');
    expect(before.accounts.size).toBe(0);
    expect(() => store.publish(prepared)).toThrow('conflict');
  });
  it('rejects stale drafts and skipped revisions before commit', () => {
    const store = new OwnerStateStore(new OwnerStateSnapshot(initial));
    const one = store.begin();
    const two = store.begin();
    expect(() => one.seal({ epoch, sequence: 2n })).toThrow('exactly once');
    store.publish(one.seal({ epoch, sequence: 1n }));
    expect(() => store.validate(two.seal({ epoch, sequence: 1n }))).toThrow('conflict');
    expect(() => store.begin(initial)).toThrow('conflict');
  });
  it('prevents mutations through Dates and wider source objects', () => {
    const host = {
      id: 1,
      apiKeyHash: 'key',
      insecureEnabledUntil: new Date('2026-10-24T00:00:00Z'),
    } as StateRow<'hosts'>;
    const store = new OwnerStateStore(new OwnerStateSnapshot(initial, { hosts: [host] }));
    host.insecureEnabledUntil!.setUTCFullYear(1990);
    const first = store.snapshot().hosts.get(1)!;
    first.insecureEnabledUntil!.setUTCFullYear(2000);
    expect(store.snapshot().hosts.get(1)!.insecureEnabledUntil!.getUTCFullYear()).toBe(2026);
    expect(() => {
      (first as { apiKeyHash: string }).apiKeyHash = 'changed';
    }).toThrow();
    expect(store.snapshot().hosts.by('apiKeyHash', 'key')).toHaveLength(1);
  });
  it('updates indexes and composite identities in drafts', () => {
    const store = new OwnerStateStore(
      new OwnerStateSnapshot(initial, {
        versions: [setting('a', 'first')],
        agentRoomReads: [{ roomId: 'room', adminId: 2, readAt: 'now' }],
      }),
    );
    const draft = store.begin();
    draft.remove('versions', 'a');
    draft.remove('agentRoomReads', ['room', 2]);
    draft.upsert('versions', setting('b', 'second'));
    expect(draft.table('versions').get('b')?.version).toBe('second');
    expect(store.snapshot().settings.get('b')).toBeUndefined();
    store.publish(draft.seal({ epoch, sequence: 1n }));
    expect(store.snapshot().settings.by('name', 'a')).toHaveLength(0);
    expect(store.snapshot().settings.by('name', 'b')).toHaveLength(1);
    expect(store.snapshot().table('agentRoomReads').size).toBe(0);
  });
  it('keeps secret values and passwords out of the hot state', () => {
    const snapshot = new OwnerStateSnapshot(initial, {
      secrets: [{ id: 1, slug: 'test', valueEnc: 'sbox:secret' } as unknown as StateRow<'secrets'>],
      hosts: [
        {
          id: 1,
          apiKey: 'legacy-secret',
          apiKeyHash: null,
          apiKeyEnc: 'sbox:key',
        } as unknown as StateRow<'hosts'>,
      ],
      adminUsers: [{ id: 1, passwordHash: 'verifier' } as unknown as StateRow<'adminUsers'>],
    });
    expect(snapshot.table('secrets').get(1)).not.toHaveProperty('valueEnc');
    expect(snapshot.hosts.get(1)).not.toHaveProperty('apiKey');
    expect(snapshot.hosts.get(1)?.apiKeyHash).toBeNull();
    expect(snapshot.hosts.get(1)?.credentialLookupHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.hosts.get(1)?.authFingerprint).toBe(snapshot.hosts.get(1)?.credentialLookupHash);
    expect(snapshot.table('adminUsers').get(1)).not.toHaveProperty('passwordHash');
  });
  it('preserves bigint revisions on the wire', () => {
    expect(wireStateRevision({ epoch, sequence: 9007199254740993n })).toEqual({
      epoch,
      sequence: '9007199254740993',
    });
  });
  it('hydrates once without request reads or background SQL', async () => {
    const mock = hydrationDb();
    const { store, stats } = await hydrateOwnerState(mock.db, initial, { totalRows: 1 });
    const hydrationCalls = mock.select.mock.calls.length;
    expect(hydrationCalls).toBeGreaterThanOrEqual(OWNED_TABLE_NAMES.length);
    expect(stats.rows).toBe(0);
    store.snapshot().settings.get('api_disabled');
    store.snapshot().hosts.by('apiKeyHash', 'absent');
    await Promise.resolve();
    expect(mock.select).toHaveBeenCalledTimes(hydrationCalls);
    const oversized = store.begin();
    oversized.upsert('versions', setting('a', '1'));
    oversized.upsert('versions', setting('b', '1'));
    expect(() => store.validate(oversized.seal({ epoch, sequence: 1n }))).toThrow('total row limit');
  });
  it('refuses readiness rather than truncating durable state over budget', async () => {
    const mock = hydrationDb([{}, {}]);
    await expect(hydrateOwnerState(mock.db, initial, { rowsPerTable: 1 })).rejects.toThrow('row limit');
    expect(mock.limit).toHaveBeenCalledWith(2);
    await expect(hydrateOwnerState(mock.db, initial, { totalRows: 1 })).rejects.toThrow('total row limit');
    await expect(hydrateOwnerState(mock.db, initial, { metadataBytes: 1 })).rejects.toThrow('byte limit');
  });
});

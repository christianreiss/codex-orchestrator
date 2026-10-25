import { claimOwnedDelivery } from '../../../src/services/agent-messaging/owned-claim.js';
import type { Keyring } from '../../../src/security/keyring.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandExecutor,
  ReceiptAlreadyExistsError,
  type CommandReceipt,
} from '../../../src/control-plane/commands.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../../../src/control-plane/state/store.js';
import { ClaudeUsageService } from '../../../src/services/claude-usage.js';
import {
  bindOwnerRuntime,
  mutateOwnerState,
  type OwnerRuntime,
} from '../../../src/control-plane/state/runtime.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { bindOwnerPresence, ConnectionPresence } from '../../../src/control-plane/presence.js';
import {
  bindOwnerRetention,
  runOwnerHistoryRetention,
} from '../../../src/services/server-retention/owner.js';
import { RetentionDeadlineIndex } from '../../../src/services/server-retention/deadlines.js';
import {
  readOwnerRetentionClock,
  retentionFacts,
  scopeHistoryCandidates,
} from '../../../src/services/server-retention/ram.js';
import { searchOwnedKnowledge, searchOwnedMemories } from '../../../src/services/runtime-knowledge.js';
import { scopedDatabase, protectOwnerReadHandle, authoritativeSnapshot } from '../../../src/db/fresh-read.js';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';

const close: Array<() => void> = [];
afterEach(() => {
  for (const stop of close.splice(0)) stop();
});
const state = (seed: unknown = {}) =>
  new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as StateSeed);
function runtime(seed: unknown = {}) {
  const store = new OwnerStateStore(state(seed)),
    receipts = new Map<string, CommandReceipt>();
  const persistence = {
    receipt: vi.fn(async (p: string, id: string) => receipts.get(p + ':' + id)),
    reserve: vi.fn(async (_tx: PersistenceTransaction, r: CommandReceipt) => {
      if (receipts.has(r.principal + ':' + r.id)) throw new ReceiptAlreadyExistsError();
    }),
    transaction: vi.fn(async (run: (tx: PersistenceTransaction) => Promise<void>) =>
      run({} as PersistenceTransaction),
    ),
    record: vi.fn(async (_tx: PersistenceTransaction, r: CommandReceipt) => {
      receipts.set(r.principal + ':' + r.id, structuredClone(r));
    }),
  };
  const committed = vi.fn(),
    deadlines = new DeadlineQueue((error) => {
      throw error;
    });
  close.push(() => deadlines.close());
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state: store,
    persistence,
    assertOwner() {},
    loseOwner(e) {
      throw e;
    },
    committed,
    notificationError(e) {
      throw e;
    },
  });
  const owner: OwnerRuntime = {
    state: store,
    deadlines,
    assertOwner() {},
    execute: (c) => executor.execute(c),
  };
  const presence = new ConnectionPresence((e) => {
    throw e;
  });
  bindOwnerPresence(owner, presence);
  close.push(() => presence.close());
  return { owner, presence, persistence, committed, receipts };
}

describe('quiet owner runtime', () => {
  it('uses actual live relay proof when old metadata omits the protocol claim, and refuses a detached relay', async () => {
    const relayId = randomUUID(),
      instance = randomUUID();
    const f = runtime({
      versions: [{ name: 'agent_messaging_enabled', version: '1', updatedAt: new Date().toISOString() }],
      agentBusRelays: [
        { id: relayId, hostId: 1, status: 'active', generation: 1, instanceId: instance, capabilities: {} },
      ],
    });
    const connection = f.presence.attach({
      connectionId: randomUUID(),
      hostId: 1,
      username: 'fixture',
      scope: { topic: 'relay', relay_id: relayId, binding_generation: 1, native_instance_id: instance },
    });
    const options = {
      targetAddressIds: [],
      leaseOwner: `relay:${relayId}:1`,
      claimId: randomUUID(),
      relayGeneration: 1,
      skipReceiveCapable: true,
      informationalOnly: false,
      smartQueue: true,
      peerBatch: false,
    };
    await expect(claimOwnedDelivery({} as Database, f.owner, {} as Keyring, options)).resolves.toBeNull();
    expect(f.persistence.transaction).not.toHaveBeenCalled();
    connection.detach();
    await expect(claimOwnedDelivery({} as Database, f.owner, {} as Keyring, options)).rejects.toMatchObject({
      code: 'agent_messaging_lease_lost',
    });
  });

  it('keeps identical Claude usage from different hosts in RAM without SQL or duplicate history', async () => {
    const now = new Date().toISOString();
    const row = {
      id: 17,
      accountId: 4,
      hostId: 1,
      source: 'statusline',
      fiveHourUsedPercent: 20,
      fiveHourResetsAt: null,
      sevenDayUsedPercent: 30,
      sevenDayResetsAt: null,
      fetchedAt: now,
      createdAt: now,
    };
    const f = runtime({ claudeUsageSnapshots: [row] });
    const db = {} as Database;
    bindOwnerRuntime(db, f.owner);
    const result = await new ClaudeUsageService(db, 4).store({
      accountId: 4,
      hostId: 200,
      source: 'native',
      fiveHourUsedPercent: 20,
      sevenDayUsedPercent: 30,
    });
    expect(result?.id).toBe(17);
    expect(result?.hostId).toBe(200);
    expect(f.persistence.transaction).not.toHaveBeenCalled();
    expect(f.owner.state.snapshot().table('claudeUsageSnapshots').all()).toHaveLength(1);
    expect(f.committed).not.toHaveBeenCalled();
  });

  it('publishes volatile activity without SQL, receipt lookup or commit notification; a no-op does not publish', async () => {
    const f = runtime(),
      publish = vi.spyOn(f.owner.state, 'publish');
    await mutateOwnerState(f.owner, {
      kind: 'observation',
      persistence: 'volatile',
      payload: {},
      prepare(c) {
        c.draft.upsert('versions', {
          name: 'volatile',
          version: 'seen',
          updatedAt: new Date().toISOString(),
        });
        return null;
      },
    });
    expect(f.owner.state.snapshot().setting('volatile')).toBe('seen');
    await mutateOwnerState(f.owner, {
      kind: 'noop',
      payload: {},
      prepare() {
        return { unchanged: true };
      },
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(f.persistence.receipt).not.toHaveBeenCalled();
    expect(f.persistence.transaction).not.toHaveBeenCalled();
    expect(f.persistence.reserve).not.toHaveBeenCalled();
    expect(f.committed).not.toHaveBeenCalled();
  });
  it('rejects SQL/effects in volatile commands before publication', async () => {
    const f = runtime();
    await expect(
      mutateOwnerState(f.owner, {
        kind: 'bad',
        persistence: 'volatile',
        payload: {},
        prepare(c) {
          c.write(async () => {});
          return null;
        },
      }),
    ).rejects.toThrow('Volatile state cannot stage SQL');
    expect(f.persistence.transaction).not.toHaveBeenCalled();
    expect(f.owner.state.revision().sequence).toBe(0n);
  });
  it('reserves genuine mutations without a preliminary SELECT and returns duplicates after the target changed', async () => {
    const f = runtime(),
      write = vi.fn();
    let allowed = true;
    const mutate = () =>
      mutateOwnerState(f.owner, {
        id: 'stable',
        kind: 'delete',
        payload: {},
        authorize() {
          if (!allowed) throw new Error('revoked');
        },
        prepare(c) {
          if (c.snapshot.setting('deleted')) throw new Error('target gone');
          c.draft.upsert('versions', { name: 'deleted', version: '1', updatedAt: new Date().toISOString() });
          c.write(async () => write());
          return { deleted: true };
        },
      });
    expect(await mutate()).toEqual({ deleted: true });
    expect(f.persistence.receipt).not.toHaveBeenCalled();
    expect(await mutate()).toEqual({ deleted: true });
    expect(write).toHaveBeenCalledTimes(1);
    allowed = false;
    await expect(mutate()).rejects.toThrow('revoked');
    await expect(
      mutateOwnerState(f.owner, {
        id: 'stable',
        kind: 'delete',
        payload: { changed: true },
        prepare() {
          return null;
        },
      }),
    ).rejects.toMatchObject({ code: 'command_id_conflict' });
  });
  it('does not open a SQL snapshot for a protected owner RAM read', async () => {
    const transaction = vi.fn(() => {
        throw new Error('SQL');
      }),
      db = scopedDatabase({ transaction });
    protectOwnerReadHandle(db);
    expect(await authoritativeSnapshot(db as unknown as Database, async () => 42)).toBe(42);
    expect(transaction).not.toHaveBeenCalled();
  });
  it('keeps content private, immutable across composed views, and within the state budget', () => {
    const base = state({ skills: [{ id: 1, slug: 'one', manifest: 'before' }] }),
      store = new OwnerStateStore(base),
      draft = store.begin();
    draft.upsert('skills', { ...base.table('skills').get(1)!, manifest: 'first' } as never);
    const first = draft.view();
    draft.upsert('skills', { ...base.table('skills').get(1)!, manifest: 'second-and-longer' } as never);
    const second = draft.view();
    expect(base.content('skills', 1, 'manifest')).toBe('before');
    expect(first.content('skills', 1, 'manifest')).toBe('first');
    expect(second.content('skills', 1, 'manifest')).toBe('second-and-longer');
    expect(second.contentBytes).toBeGreaterThan(first.contentBytes);
    expect(second.table('skills').get(1)).not.toHaveProperty('manifest');
    expect(
      JSON.stringify(second, (_, value) => (typeof value === 'bigint' ? value.toString() : value)),
    ).not.toContain('second-and-longer');
    expect(
      () => new OwnerStateStore(second, { metadataBytes: second.metadataUsage.metadataBytes - 1 }),
    ).toThrow();
    draft.remove('skills', 1);
    expect(draft.view().content('skills', 1, 'manifest')).toBeUndefined();
    expect(first.content('skills', 1, 'manifest')).toBe('first');
  });
  it('protects paused jobs, uncertain work and unended native scopes entirely in RAM', async () => {
    const now = new Date().toISOString(),
      old = '2020-01-01T00:00:00.000Z';
    const seed = {
      agentSessions: [{ id: 'native', agentBusAddressId: 'a', endedAt: null, heartbeatAt: old }],
      agentBusAddresses: [{ id: 'a', lastSeenAt: old }],
      agentScopeMembers: [{ id: 1, scopeId: 'scope', sessionId: 'native' }],
      agentScopeEvents: Array.from({ length: 200 }, (_, i) => ({
        id: 'e' + i,
        scopeId: 'scope',
        createdAt: old,
        dispatched: 1,
      })),
      agentSchedules: [{ id: 'paused', targetAddressId: 'b', enabled: 0, deletedAt: null }],
      agentBusMessages: [
        {
          id: 'unknown',
          senderAddressId: 'c',
          targetAddressId: 'd',
          status: 'completed',
          taskResultStatus: 'unknown',
        },
      ],
    };
    const f = runtime(seed),
      facts = retentionFacts(f.owner.state.snapshot(), now);
    expect([...facts.protectedAddresses]).toEqual(expect.arrayContaining(['b', 'c', 'd']));
    expect(facts.protectedScopes.has('scope')).toBe(true);
    expect(scopeHistoryCandidates(f.owner.state.snapshot(), now)).toEqual([]);
    const index = new RetentionDeadlineIndex();
    await index.hydrate(async () => ({ past: true, next: null }));
    bindOwnerRetention(f.owner, index);
    expect(await runOwnerHistoryRetention({} as Database, f.owner, 'rooms', {} as Env)).toBe(0);
    expect(f.persistence.transaction).not.toHaveBeenCalled();
    expect(
      scopeHistoryCandidates(
        state({
          ...seed,
          agentSessions: [{ ...seed.agentSessions[0], endedAt: old }],
          agentSchedules: [],
          agentBusMessages: [],
        }),
        now,
      ),
    ).toHaveLength(100);
    const clock = readOwnerRetentionClock(
      state({ agentScopeEvents: seed.agentScopeEvents, agentSessions: [{ id: 'future', heartbeatAt: now }] }),
      'rooms',
      Date.now(),
      24,
    );
    expect(clock.past).toBe(true);
    expect(clock.next).toBeGreaterThan(Date.now());
  });
  it('serves ranked current knowledge and isolates host memories with no SQL fallback', () => {
    const shared = {
      id: 1,
      slug: 'db',
      title: 'Database',
      content: '## Recovery\nThe database recovery token is current.',
      updatedAt: '2026-01-01',
      tags: ['ops'],
      chunkCount: 1,
      contentLength: 65,
    };
    const snapshot = state({
      sharedMemories: [shared],
      mcpMemories: [
        { id: 1, hostId: 10, content: 'sensitive recovery', updatedAt: '2026-01-01', deletedAt: null },
        { id: 2, hostId: 20, content: 'private recovery', updatedAt: '2026-01-01', deletedAt: null },
      ],
    });
    expect(searchOwnedKnowledge(snapshot, 'recovery', ['ops'])[0]?.slug).toBe('db');
    expect(searchOwnedKnowledge(snapshot, 'missing', [])).toEqual([]);
    expect(searchOwnedMemories(snapshot, 'mcpMemories', 10, 'recovery', []).map((r) => r.content)).toEqual([
      'sensitive recovery',
    ]);
    const draft = new OwnerStateStore(snapshot).begin();
    draft.upsert('sharedMemories', { ...shared, content: 'Completely replaced material' } as never);
    expect(searchOwnedKnowledge(draft.view(), 'recovery', [])).toEqual([]);
    expect(searchOwnedKnowledge(snapshot, 'recovery', [])).toHaveLength(1);
  });
});

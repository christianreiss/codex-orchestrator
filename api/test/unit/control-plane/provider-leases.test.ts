import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import {
  acquireOwnedProvider,
  drainOwnedProviders,
  ownedProviderSession,
  releaseOwnedProvider,
} from '../../../src/control-plane/streams/provider-leases.js';
import { createDbFake } from '../../helpers/db-fake.js';
const queues: DeadlineQueue[] = [];
afterEach(() => {
  queues.splice(0).forEach((q) => q.close());
});
function harness(rows: Record<string, Record<string, unknown>[]> = {}) {
  const now = new Date().toISOString();
  const seed = {
    providerAccounts: [
      {
        id: 1,
        engine: 'codex',
        state: 'enabled',
        payloadId: 1,
        lastSelectedAt: null,
        mergedIntoAccountId: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    authPayloads: [{ id: 1, engine: 'codex', accountId: 1, verificationState: 'verified' }],
    ...rows,
  };
  const db = createDbFake(
    new Map(
      Object.entries(seed).map(([name, values]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone(values),
      ]),
    ),
  );
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
  );
  const deadlines = new DeadlineQueue((e) => {
    throw e;
  });
  queues.push(deadlines);
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(e) {
      throw e;
    },
    committed() {},
    notificationError(e) {
      throw e;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(db as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const owner: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  const select = vi.spyOn(db, 'select');
  return { owner, state, db, select };
}
describe('durable provider ownership', () => {
  it('grants connection ownership and never expires or reassigns it from a transport loss', async () => {
    const h = harness();
    const id = 'a'.repeat(32);
    const lease = await acquireOwnedProvider(h.owner, 1, 'codex', 'scope', id, 90);
    expect(lease.ownership_mode).toBe('connection');
    expect(ownedProviderSession(h.owner, 1, 'codex', id).accountId).toBe(1);
    const draft = h.state.begin();
    draft.upsert('providerAccountSessions', {
      ...h.state.snapshot().table('providerAccountSessions').get(id)!,
      expiresAt: '2000-01-01T00:00:00Z',
    });
    h.state.publish(draft.seal({ ...h.state.revision(), sequence: h.state.revision().sequence + 1n }));
    const revision = h.state.revision().sequence;
    await drainOwnedProviders(h.owner);
    expect(h.state.revision().sequence).toBe(revision);
    expect(ownedProviderSession(h.owner, 1, 'codex', id).id).toBe(id);
    expect(h.select).not.toHaveBeenCalled();
    await releaseOwnedProvider(h.owner, 1, 'codex', id);
    expect(h.state.snapshot().table('providerAccountSessions').get(id)).toBeUndefined();
  });
  it('keeps an active timed grant timed, and rejects expired timed grants until a new acquire', async () => {
    const id = 'b'.repeat(32);
    const h = harness({
      providerAccountSessions: [
        {
          id,
          hostId: 1,
          engine: 'codex',
          scopeId: 'scope',
          accountId: 1,
          ownershipMode: 'timed',
          createdAt: new Date().toISOString(),
          expiresAt: '2099-01-01T00:00:00Z',
        },
      ],
    });
    expect((await acquireOwnedProvider(h.owner, 1, 'codex', 'scope', id, 90)).ownership_mode).toBe('timed');
    const draft = h.state.begin();
    draft.upsert('providerAccountSessions', {
      ...h.state.snapshot().table('providerAccountSessions').get(id)!,
      expiresAt: '2000-01-01T00:00:00Z',
    });
    h.state.publish(draft.seal({ ...h.state.revision(), sequence: h.state.revision().sequence + 1n }));
    expect(() => ownedProviderSession(h.owner, 1, 'codex', id)).toThrow('not found');
    await drainOwnedProviders(h.owner);
    expect(h.state.snapshot().table('providerAccountSessions').get(id)).toBeUndefined();
    expect((await acquireOwnedProvider(h.owner, 1, 'codex', 'scope', id, 90)).ownership_mode).toBe(
      'connection',
    );
    expect(h.select).not.toHaveBeenCalled();
  });
  it('does not let another host release or reuse a durable identity', async () => {
    const h = harness();
    const id = 'c'.repeat(32);
    await acquireOwnedProvider(h.owner, 1, 'codex', 'scope', id, 90);
    await expect(acquireOwnedProvider(h.owner, 2, 'codex', 'scope', id, 90)).rejects.toThrow(
      'already in use',
    );
    await releaseOwnedProvider(h.owner, 2, 'codex', id);
    expect(h.state.snapshot().table('providerAccountSessions').get(id)?.hostId).toBe(1);
  });
});

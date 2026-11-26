import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { OwnerStateSnapshot, OwnerStateStore, type PreparedOwnerState } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import {
  DETACHED_LEASE_GRACE_MS,
  acquireOwnedProvider,
  freshBindingGeneration,
  noteProviderRenewal,
  reapAbandonedProviders,
} from '../../../src/control-plane/streams/provider-leases.js';
import { createDbFake } from '../../helpers/db-fake.js';

const queues: DeadlineQueue[] = [];
afterEach(() => {
  queues.splice(0).forEach((q) => q.close());
});

const LIVE = new Set(['claude']);

function harness() {
  const now = new Date().toISOString();
  const account = (id: number, engine: string) => ({
    id,
    engine,
    state: 'enabled',
    payloadId: id,
    lastSelectedAt: null,
    mergedIntoAccountId: null,
    createdAt: now,
    updatedAt: now,
  });
  const seed = {
    hosts: [{ id: 1, fqdn: 'one.test' }],
    providerAccounts: [account(1, 'claude'), account(2, 'codex')],
    authPayloads: [
      { id: 1, engine: 'claude', accountId: 1, verificationState: 'verified' },
      { id: 2, engine: 'codex', accountId: 2, verificationState: 'verified' },
    ],
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
  const owner: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: (command) => executor.execute(command) };
  const presence = new ConnectionPresence((e) => {
    throw e;
  });
  bindOwnerPresence(owner, presence);
  const attach = (id: string, engine: string) =>
    presence.attach({
      connectionId: randomUUID(),
      hostId: 1,
      username: 'u',
      scope: { topic: 'provider', provider_session_id: id, engine } as never,
    });
  const lease = (id: string) => state.snapshot().table('providerAccountSessions').get(id);
  return { owner, state, attach, lease };
}

describe('abandoned provider leases', () => {
  it('removes a connection-owned lease once its attachment has been gone for the grace period', async () => {
    const h = harness();
    const dead = 'd'.repeat(32);
    const alive = 'a'.repeat(32);
    await acquireOwnedProvider(h.owner, 1, 'claude', 'scope-dead', dead, 90);
    await acquireOwnedProvider(h.owner, 1, 'claude', 'scope-alive', alive, 90);
    h.attach(alive, 'claude');
    const t0 = Date.now();
    noteProviderRenewal(h.owner, dead, t0 - 60_000);
    noteProviderRenewal(h.owner, alive, t0 - 60_000);
    // Absence counts from the first look, not from anything stored.
    expect(await reapAbandonedProviders(h.owner, LIVE, t0)).toEqual([]);
    expect(await reapAbandonedProviders(h.owner, LIVE, t0 + DETACHED_LEASE_GRACE_MS - 1000)).toEqual([]);
    expect(await reapAbandonedProviders(h.owner, LIVE, t0 + DETACHED_LEASE_GRACE_MS)).toEqual([dead]);
    expect(h.lease(dead)).toBeUndefined();
    expect(h.lease(alive)).toBeDefined();
  });

  it('starts the grace period again when the attachment came back in between', async () => {
    const h = harness();
    const id = 'b'.repeat(32);
    await acquireOwnedProvider(h.owner, 1, 'claude', 'scope', id, 90);
    const t0 = Date.now();
    noteProviderRenewal(h.owner, id, t0 - 60_000);
    expect(await reapAbandonedProviders(h.owner, LIVE, t0)).toEqual([]);
    const back = h.attach(id, 'claude');
    expect(await reapAbandonedProviders(h.owner, LIVE, t0 + 4 * 60_000)).toEqual([]);
    back.detach();
    expect(await reapAbandonedProviders(h.owner, LIVE, t0 + 6 * 60_000)).toEqual([]);
    expect(await reapAbandonedProviders(h.owner, LIVE, t0 + 6 * 60_000 + DETACHED_LEASE_GRACE_MS)).toEqual([id]);
  });

  it('keeps a lease whose holder never renewed it, and one that still sends heartbeats', async () => {
    const h = harness();
    const old = 'e'.repeat(32);
    const beating = 'h'.repeat(32);
    // A wrapper before the switch supervisor only redials its attachment: it could not take the lease back.
    await acquireOwnedProvider(h.owner, 1, 'claude', 'scope-old', old, 90);
    await acquireOwnedProvider(h.owner, 1, 'claude', 'scope-beating', beating, 90);
    const t0 = Date.now();
    noteProviderRenewal(h.owner, beating, t0);
    expect(await reapAbandonedProviders(h.owner, LIVE, t0)).toEqual([]);
    noteProviderRenewal(h.owner, beating, t0 + DETACHED_LEASE_GRACE_MS - 60_000);
    expect(await reapAbandonedProviders(h.owner, LIVE, t0 + DETACHED_LEASE_GRACE_MS)).toEqual([]);
    expect(await reapAbandonedProviders(h.owner, LIVE, t0 + 2 * DETACHED_LEASE_GRACE_MS)).toEqual([beating]);
    expect(await reapAbandonedProviders(h.owner, LIVE, t0 + 20 * DETACHED_LEASE_GRACE_MS)).toEqual([]);
    expect(h.lease(old)).toBeDefined();
  });

  it('never removes an internal lease for absence', async () => {
    const h = harness();
    const internal = 'i'.repeat(32);
    await acquireOwnedProvider(h.owner, 0, 'claude', internal, internal, 90);
    const t0 = Date.now();
    noteProviderRenewal(h.owner, internal, t0 - 60_000);
    expect(await reapAbandonedProviders(h.owner, LIVE, t0)).toEqual([]);
    expect(await reapAbandonedProviders(h.owner, LIVE, t0 + 10 * DETACHED_LEASE_GRACE_MS)).toEqual([]);
    expect(h.lease(internal)).toBeDefined();
  });

  it('leaves other engines and timed leases alone, and removes every lease of a deleted host', async () => {
    const h = harness();
    const codex = 'c'.repeat(32);
    const timed = 't'.repeat(32);
    const orphan = 'o'.repeat(32);
    await acquireOwnedProvider(h.owner, 1, 'codex', 'scope-codex', codex, 90);
    await acquireOwnedProvider(h.owner, 1, 'claude', 'scope-timed', timed, 90, undefined, 'timed');
    await acquireOwnedProvider(h.owner, 7, 'codex', 'scope-orphan', orphan, 90);
    const t0 = Date.now();
    for (const id of [codex, timed]) noteProviderRenewal(h.owner, id, t0 - 60_000);
    // Host 7 does not exist: its lease goes at once, whatever the engine.
    expect(await reapAbandonedProviders(h.owner, LIVE, t0)).toEqual([orphan]);
    expect(await reapAbandonedProviders(h.owner, LIVE, t0 + 10 * DETACHED_LEASE_GRACE_MS)).toEqual([]);
    expect(h.lease(codex)).toBeDefined();
    expect(h.lease(timed)).toBeDefined();
  });
});

describe('binding generation of a new scope', () => {
  it('never starts below a generation the scope had before', async () => {
    const h = harness();
    const first = 'f'.repeat(32);
    const sibling = 's'.repeat(32);
    const before = freshBindingGeneration();
    await acquireOwnedProvider(h.owner, 1, 'claude', 'scope', first, 90);
    const started = h.lease(first)!.bindingGeneration!;
    expect(started).toBeGreaterThanOrEqual(before);
    // A lease joining the live scope shares its generation.
    await acquireOwnedProvider(h.owner, 1, 'claude', 'scope', sibling, 90);
    expect(h.lease(sibling)!.bindingGeneration).toBe(started);
    // Later scopes of the same name start above it, also after switches moved it up.
    expect(freshBindingGeneration(Date.now() + 60_000)).toBeGreaterThan(started + 10);
    expect(freshBindingGeneration(Date.parse('2106-01-01T00:00:00Z'))).toBeLessThan(2 ** 32);
  });
});

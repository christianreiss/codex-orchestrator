import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStorageOwnership } from '../../src/control-plane/storage-owner.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import type { RowDataPacket } from 'mysql2/promise';
import { getTestDb } from '../helpers/test-db.js';
import { testKeyring } from '../helpers/test-keyring.js';
import { runMigrations } from '../../src/db/migrator.js';
import * as schema from '../../src/db/schema.js';
import { ControlPlaneOwnership } from '../../src/control-plane/owner.js';
import { OwnerPersistence, type PersistenceTransaction } from '../../src/control-plane/persistence.js';
import { CommandExecutor, type Revision } from '../../src/control-plane/commands.js';
import { OwnerStateStore, OwnerStateSnapshot } from '../../src/control-plane/state/store.js';
import { hydrateOwnerState } from '../../src/control-plane/state/hydrate.js';

const handle = await getTestDb();
describe.skipIf(!handle)('owner persistence against real MySQL', () => {
  beforeAll(async () => {
    await runMigrations(handle!.pool);
  }, 300_000);
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('retains one exclusive owner while hydrating an authoritative snapshot', async () => {
    const owner = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test');
    const competitor = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test');
    try {
      await owner.acquire();
      const hydrated = await owner.hydrate((connection, epoch) =>
        hydrateOwnerState(drizzle(connection, { schema, mode: 'default' }), { epoch, sequence: 0n }),
      );
      expect(hydrated.stats.tables.hosts).toBeDefined();
      owner.ready();
      await expect(competitor.acquire()).rejects.toThrow('Another');
      owner.assertReady();
    } finally {
      await competitor.close();
      await owner.close();
    }
  });
  it('atomically stores encrypted result and outbox, rolls back invalid writes, and replays after restart', async () => {
    const principal = 'test:' + randomUUID(),
      id = randomUUID(),
      effect = randomUUID();
    const keyring = testKeyring();
    const owner = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test');
    await owner.acquire();
    await owner.hydrate(async () => undefined);
    owner.ready();
    const store = new OwnerStateStore(new OwnerStateSnapshot({ epoch: owner.epoch, sequence: 0n }));
    const persistence = new OwnerPersistence(owner, keyring);
    const commands = new CommandExecutor({
      state: store,
      persistence,
      assertOwner: () => owner.assertReady(),
      loseOwner: (error) => owner.lose(error),
      committed: () => {},
      notificationError: () => {},
    });
    try {
      const result = await commands.execute({
        principal,
        id,
        kind: 'fixture.accept',
        payload: { value: 1 },
        authorize: () => {},
        prepare: (_snapshot, revision) => ({
          state: store.begin().seal(revision),
          result: { secret: 'test-only-response' },
          persist: async () => {},
          outbox: [
            {
              id: effect,
              kind: 'fixture.effect',
              target: 'fixture',
              payload: { secret: 'test-only-effect' },
              availableAt: new Date().toISOString(),
            },
          ],
        }),
      });
      expect(result).toEqual({ secret: 'test-only-response' });
      const [receipts] = await handle!.pool.query<RowDataPacket[]>(
        'SELECT result_enc FROM control_plane_command_receipts WHERE principal = ?',
        [principal],
      );
      expect(receipts[0]?.result_enc).toMatch(/^sbox:v1:/);
      expect(receipts[0]?.result_enc).not.toContain('test-only-response');
      const [effects] = await handle!.pool.query<RowDataPacket[]>(
        'SELECT payload_enc, status FROM control_plane_outbox WHERE id = ?',
        [effect],
      );
      expect(effects[0]?.status).toBe('pending');
      expect(effects[0]?.payload_enc).not.toContain('test-only-effect');
      const failed = randomUUID();
      await expect(
        commands.execute({
          principal,
          id: failed,
          kind: 'fixture.reject',
          payload: {},
          authorize: () => {},
          prepare: (_snapshot, revision) => ({
            state: store.begin().seal(revision),
            result: null,
            persist: async (tx) => {
              await tx
                .insert(schema.versions)
                .values({ name: 'owner-test-' + failed, version: '1', updatedAt: new Date().toISOString() });
              throw new Error('intentional rollback');
            },
          }),
        }),
      ).rejects.toThrow('intentional rollback');
      const [rows] = await handle!.pool.query<RowDataPacket[]>('SELECT name FROM versions WHERE name = ?', [
        'owner-test-' + failed,
      ]);
      expect(rows).toHaveLength(0);
      expect(await persistence.receipt(principal, failed)).toBeUndefined();
      expect(store.revision().sequence).toBe(1n);
    } finally {
      await commands.drain();
      await owner.close();
    }
    const replacement = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test');
    try {
      await replacement.acquire();
      await replacement.hydrate(async () => undefined);
      replacement.ready();
      const receipt = await new OwnerPersistence(replacement, keyring).receipt(principal, id);
      expect(receipt?.result).toEqual({ secret: 'test-only-response' });
      expect(receipt?.revision.epoch).not.toBe(replacement.epoch);
    } finally {
      await replacement.close();
      await handle!.pool.query('DELETE FROM control_plane_outbox WHERE id = ?', [effect]);
      await handle!.pool.query('DELETE FROM control_plane_command_receipts WHERE principal = ?', [principal]);
    }
  });
  async function freshOwner(keyring = testKeyring()) {
    const owner = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test');
    await owner.acquire();
    const { store } = await owner.hydrate((connection, epoch) =>
      hydrateOwnerState(drizzle(connection, { schema, mode: 'default' }), { epoch, sequence: 0n }),
    );
    owner.ready();
    const persistence = new OwnerPersistence(owner, keyring);
    const commands = new CommandExecutor({
      state: store,
      persistence,
      assertOwner: () => owner.assertReady(),
      loseOwner: (error) => owner.lose(error),
      committed: () => {},
      notificationError: () => {},
    });
    return { owner, store, persistence, commands };
  }
  function fixtureCommand(
    store: OwnerStateStore,
    principal: string,
    id: string,
    effect: string,
    name: string,
  ) {
    return {
      principal,
      id,
      kind: 'fixture.durable_change',
      payload: { name },
      authorize: () => {},
      prepare: (_snapshot: OwnerStateSnapshot, revision: Revision) => {
        const row = { name, version: 'committed', updatedAt: new Date().toISOString() };
        const draft = store.begin();
        draft.upsert('versions', row);
        return {
          state: draft.seal(revision),
          result: { value: 'committed' },
          persist: async (tx: PersistenceTransaction) => {
            await tx.insert(schema.versions).values(row);
          },
          outbox: [
            {
              id: effect,
              kind: 'fixture.effect',
              target: 'fixture',
              payload: { name },
              availableAt: row.updatedAt,
            },
          ],
        };
      },
    };
  }
  async function cleanupFault(principal: string, name: string) {
    await handle!.pool.query('DELETE FROM control_plane_outbox WHERE principal = ?', [principal]);
    await handle!.pool.query('DELETE FROM control_plane_command_receipts WHERE principal = ?', [principal]);
    await handle!.pool.query('DELETE FROM versions WHERE name = ?', [name]);
  }
  it('persists after many volatile revisions without advancing the durable counter for observations', async () => {
    const f = await freshOwner(),
      principal = 'test:' + randomUUID(),
      name = 'quiet-revision-' + randomUUID();
    try {
      for (let i = 0; i < 20; i++) {
        await f.commands.execute({
          principal,
          id: randomUUID(),
          kind: 'fixture.observe',
          payload: { i },
          authorize() {},
          prepare(_snapshot, revision) {
            const draft = f.store.begin();
            draft.upsert('versions', { name, version: String(i), updatedAt: new Date().toISOString() });
            return {
              persistence: 'volatile',
              state: draft.seal(revision),
              result: null,
              persist: async () => {
                throw new Error('Observation wrote SQL');
              },
            };
          },
        });
      }
      const [before] = await handle!.pool.query<RowDataPacket[]>(
        'SELECT sequence FROM control_plane_owner WHERE id=1',
      );
      expect(Number(before[0]!.sequence)).toBe(0);
      const effect = randomUUID();
      await f.commands.execute(fixtureCommand(f.store, principal, randomUUID(), effect, name));
      expect(f.store.revision().sequence).toBe(21n);
      const [after] = await handle!.pool.query<RowDataPacket[]>(
        'SELECT sequence FROM control_plane_owner WHERE id=1',
      );
      expect(Number(after[0]!.sequence)).toBe(1);
      const [receipts] = await handle!.pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM control_plane_command_receipts WHERE principal=?',
        [principal],
      );
      expect(Number(receipts[0]!.n)).toBe(1);
    } finally {
      await f.commands.drain();
      await f.owner.close();
      await cleanupFault(principal, name);
    }
  });
  it.each(['commit_ack', 'publication'] as const)(
    'reconstructs after real commit followed by %s loss without duplicate state or effects',
    async (fault) => {
      const principal = 'test:' + randomUUID(),
        id = randomUUID(),
        effect = randomUUID(),
        name = 'owner-fault-' + randomUUID();
      const keyring = testKeyring(),
        first = await freshOwner(keyring);
      let replacement: Awaited<ReturnType<typeof freshOwner>> | undefined;
      try {
        if (fault === 'commit_ack') {
          const connection = first.owner.heldConnection(),
            commit = connection.commit.bind(connection);
          vi.spyOn(connection, 'commit').mockImplementationOnce(async () => {
            await commit();
            throw new Error('synthetic lost COMMIT acknowledgement');
          });
        } else {
          vi.spyOn(first.store, 'publish').mockImplementationOnce(() => {
            throw new Error('synthetic RAM publication failure');
          });
        }
        const command = fixtureCommand(first.store, principal, id, effect, name);
        const successorPrepare = vi.fn(() => {
          throw new Error('fenced successor must not prepare');
        });
        const outcomes = await Promise.allSettled([
          first.commands.execute(command),
          first.commands.execute({ ...command, id: randomUUID(), prepare: successorPrepare }),
        ]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
        expect(first.owner.status()).toBe('lost');
        expect(successorPrepare).not.toHaveBeenCalled();
        expect(first.store.snapshot().setting(name)).toBeNull();
        const [committed] = await handle!.pool.query<RowDataPacket[]>(
          'SELECT version FROM versions WHERE name = ?',
          [name],
        );
        expect(committed.map((row) => row.version)).toEqual(['committed']);
        await first.commands.drain();
        await first.owner.close();
        replacement = await freshOwner(keyring);
        expect(replacement.store.snapshot().setting(name)).toBe('committed');
        const replayPrepare = vi.fn(() => {
          throw new Error('the already-mutated target no longer validates');
        });
        const result = await replacement.commands.execute({
          ...fixtureCommand(replacement.store, principal, id, effect, name),
          prepare: replayPrepare,
        });
        expect(result).toEqual({ value: 'committed' });
        expect(replayPrepare).toHaveBeenCalledOnce();
        // Pure validation may run again; no domain write, effect or publication may replay.
        expect(replacement.store.revision().sequence).toBe(0n);
        const [receipts] = await handle!.pool.query<RowDataPacket[]>(
          'SELECT request_id FROM control_plane_command_receipts WHERE principal = ?',
          [principal],
        );
        const [effects] = await handle!.pool.query<RowDataPacket[]>(
          'SELECT id, status FROM control_plane_outbox WHERE principal = ?',
          [principal],
        );
        expect(receipts.map((row) => row.request_id)).toEqual([id]);
        expect(effects.map((row) => ({ id: row.id, status: row.status }))).toEqual([
          { id: effect, status: 'pending' },
        ]);
      } finally {
        await first.commands.drain();
        await first.owner.close();
        if (replacement) {
          await replacement.commands.drain();
          await replacement.owner.close();
        }
        await cleanupFault(principal, name);
      }
    },
    60_000,
  );

  it('fences a paused prepared command after its actual owner MySQL connection is killed', async () => {
    const principal = 'test:' + randomUUID(),
      id = randomUUID(),
      effect = randomUUID(),
      name = 'owner-kill-' + randomUUID();
    const first = await freshOwner();
    const storageRoot = await mkdtemp(join(tmpdir(), 'owner-db-loss-'));
    const storageOwner = await acquireStorageOwnership(storageRoot);
    let replacement: Awaited<ReturnType<typeof freshOwner>> | undefined;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const command = fixtureCommand(first.store, principal, id, effect, name);
    const persist = vi.fn();
    const lost = new Promise<void>((resolve) => first.owner.onLost(() => resolve()));
    try {
      const [connection] = await first.owner
        .heldConnection()
        .query<RowDataPacket[]>('SELECT CONNECTION_ID() AS id');
      const connectionId = Number(connection[0]!.id);
      expect(Number.isSafeInteger(connectionId) && connectionId > 0).toBe(true);
      const pending = first.commands.execute({
        ...command,
        prepare: async (snapshot, revision) => {
          const prepared = command.prepare(snapshot, revision);
          entered();
          await gate;
          return {
            ...prepared,
            persist: async (tx: PersistenceTransaction) => {
              persist();
              await prepared.persist(tx);
            },
          };
        },
      });
      // Attach rejection handling before killing the one connection owned by this test.
      const outcome = Promise.allSettled([pending]);
      await ready;
      await handle!.pool.query('KILL CONNECTION ?', [connectionId]);
      await lost;
      expect(first.owner.status()).toBe('lost');
      // Losing SQL ownership cannot make a surviving process's pending file
      // effects overlap a replacement. Normal server boot checks this first.
      await expect(acquireStorageOwnership(storageRoot)).rejects.toThrow('still owns application storage');
      replacement = await freshOwner();
      release();
      expect((await outcome)[0]!.status).toBe('rejected');
      expect(persist).not.toHaveBeenCalled();
      replacement.owner.assertReady();
      expect(replacement.store.snapshot().setting(name)).toBeNull();
      const [rows] = await handle!.pool.query<RowDataPacket[]>('SELECT name FROM versions WHERE name = ?', [
        name,
      ]);
      const [effects] = await handle!.pool.query<RowDataPacket[]>(
        'SELECT id FROM control_plane_outbox WHERE principal = ?',
        [principal],
      );
      expect(rows).toHaveLength(0);
      expect(effects).toHaveLength(0);
      expect(await replacement.persistence.receipt(principal, id)).toBeUndefined();
      await first.commands.drain();
      await storageOwner.close();
      const nextStorageOwner = await acquireStorageOwnership(storageRoot);
      await nextStorageOwner.close();
    } finally {
      release();
      await first.commands.drain();
      await first.owner.close();
      await storageOwner.close();
      await rm(storageRoot, { recursive: true, force: true });
      if (replacement) {
        await replacement.commands.drain();
        await replacement.owner.close();
      }
      await cleanupFault(principal, name);
    }
  }, 60_000);
  it('rolls back actual SQL writes when generated metadata exceeds the runtime budget', async () => {
    const principal = 'test:' + randomUUID(),
      id = randomUUID(),
      effect = randomUUID(),
      name = 'owner-budget-' + randomUUID();
    const first = await freshOwner();
    const store = new OwnerStateStore(first.store.snapshot(), {
      metadataBytes: first.store.snapshot().metadataUsage.metadataBytes,
    });
    const commands = new CommandExecutor({
      state: store,
      persistence: first.persistence,
      assertOwner: () => first.owner.assertReady(),
      loseOwner: (error) => first.owner.lose(error),
      committed: () => {},
      notificationError: () => {},
    });
    let wrote = false;
    try {
      const command = fixtureCommand(store, principal, id, effect, name);
      await expect(
        commands.execute({
          ...command,
          prepare(snapshot, revision) {
            const prepared = command.prepare(snapshot, revision);
            return {
              ...prepared,
              state: undefined,
              async persist(tx: PersistenceTransaction) {
                await prepared.persist(tx);
                wrote = true;
                return prepared.state;
              },
            };
          },
        }),
      ).rejects.toThrow('metadata byte limit');
      expect(wrote).toBe(true);
      first.owner.assertReady();
      expect(store.snapshot()).toBe(first.store.snapshot());
      const [rows] = await handle!.pool.query<RowDataPacket[]>('SELECT name FROM versions WHERE name = ?', [
        name,
      ]);
      const [effects] = await handle!.pool.query<RowDataPacket[]>(
        'SELECT id FROM control_plane_outbox WHERE principal = ?',
        [principal],
      );
      expect(rows).toHaveLength(0);
      expect(effects).toHaveLength(0);
      expect(await first.persistence.receipt(principal, id)).toBeUndefined();
    } finally {
      await commands.drain();
      await first.commands.drain();
      await first.owner.close();
      await cleanupFault(principal, name);
    }
  }, 60_000);
});

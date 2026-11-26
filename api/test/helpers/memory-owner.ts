/**
 * An in-process control-plane owner over `db-fake`: real `CommandExecutor`,
 * real `OwnerStateStore`, persistence writes applied to the fake tables. The
 * same composition as `transfers-owner.test.ts`, shared for tests that drive
 * owner-only services (writes go through `mutateOwnerState`).
 */
import { randomUUID } from 'node:crypto';
import * as schema from '../../src/db/schema.js';
import { CommandExecutor } from '../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../src/control-plane/deadlines.js';
import { OwnerStateSnapshot, OwnerStateStore, type PreparedOwnerState } from '../../src/control-plane/state/store.js';
import type { StateSeed } from '../../src/control-plane/state/catalog.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../src/control-plane/persistence.js';
import type { Database } from '../../src/db/client.js';
import { createDbFake, type DbFake } from './db-fake.js';

export interface MemoryOwner {
  db: Database;
  fake: DbFake;
  owner: OwnerRuntime;
  state: OwnerStateStore;
  deadlines: DeadlineQueue;
  close(): void;
}

export function memoryOwner(seed: Record<string, Record<string, unknown>[]> = {}): MemoryOwner {
  const fake = createDbFake(
    new Map(
      Object.entries(seed).map(([name, rows]) => [(schema as unknown as Record<string, unknown>)[name], structuredClone(rows)]),
    ),
  );
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, structuredClone(seed) as unknown as StateSeed),
  );
  const deadlines = new DeadlineQueue((e) => {
    throw e;
  });
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
        await run(fake as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const owner: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: (command) => executor.execute(command) };
  const db = fake as unknown as Database;
  bindOwnerRuntime(db, owner);
  return { db, fake, owner, state, deadlines, close: () => deadlines.close() };
}

/** Rows the fake persisted for one table. */
export function persisted(fake: DbFake, table: unknown): Record<string, unknown>[] {
  return (fake.tables.get(table) ?? []) as Record<string, unknown>[];
}

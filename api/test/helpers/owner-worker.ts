import { ConnectionPresence, bindOwnerPresence } from '../../src/control-plane/presence.js';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../src/db/client.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../src/control-plane/state/store.js';
import { DeadlineQueue } from '../../src/control-plane/deadlines.js';
import type { StateSeed } from '../../src/control-plane/state/catalog.js';
import {
  bindOwnerMaintenanceCommands,
  type OwnerMaintenanceCommands,
} from '../../src/ops/owner-maintenance.js';
import { RetentionDeadlineIndex } from '../../src/services/server-retention/deadlines.js';

export async function ownerWorkerFixture(seed: StateSeed = {}) {
  const db = {} as Database,
    error = vi.fn();
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed));
  const runtime = {
    state,
    deadlines: new DeadlineQueue(error),
    assertOwner: vi.fn(),
    execute: vi.fn(),
  } as unknown as OwnerRuntime;
  bindOwnerRuntime(db, runtime);
  const presence = new ConnectionPresence(error);
  bindOwnerPresence(runtime, presence);
  const retention = new RetentionDeadlineIndex();
  await retention.hydrate(async () => ({ past: false, next: null }));
  const run = vi.fn<OwnerMaintenanceCommands['run']>();
  const commands: OwnerMaintenanceCommands = {
    run,
    retention,
    facts: {
      relayConnected: () => false,
      relayHeldWorkGoneAt: () => null,
      sessionConnected: () => false,
      receiverConnected: () => false,
      revision: () => '1',
      conferenceHasPendingDeliveries: () => false,
    },
    subscribeFacts: () => () => {},
  };
  bindOwnerMaintenanceCommands(db, commands);
  const closers: Array<() => Promise<void>> = [];
  const app = {
    log: { error, warn: error, info: vi.fn() },
    addHook: (_: string, fn: () => Promise<void>) => {
      closers.push(fn);
    },
  } as unknown as FastifyInstance;
  return {
    db,
    state,
    app,
    runtime,
    retention,
    run,
    error,
    close: async () => {
      for (const fn of closers) await fn();
      presence.close();
      runtime.deadlines.close();
    },
  };
}

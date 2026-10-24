import { publishOwnerStateChanges } from '../ws/publisher.js';
import { trackBoardOwnership } from './state/board-ownership.js';
import { reconcileWorkflowOwnership } from './state/workflow-ownership.js';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { and, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { runBootMigrations } from '../ops/boot-migrations.js';
import { CommandExecutor, type CommandReceipt, type OutboxIntent } from './commands.js';
import { ControlPlaneOwnership } from './owner.js';
import { OwnerPersistence, type PersistenceTransaction } from './persistence.js';
import { DeadlineQueue } from './deadlines.js';
import { hydrateOwnerState } from './state/hydrate.js';
import { bindOwnerRuntime, type OwnerRuntime } from './state/runtime.js';
import { ConnectionPresence, bindOwnerPresence } from './presence.js';
import { trackHostActivity, stopHostActivity } from './state/host-activity.js';
import { ConnectionCredentials } from './credentials.js';
import { LegacyDrainRegistry, captureLegacyDrainManifest } from './legacy-drain.js';
import { readLegacyCutoverManifest, filterLegacyCutoverManifest } from './legacy-cutover.js';
import { join } from 'node:path';
import { AGENT_MESSAGING_RELAY_TOKEN_SECONDS } from '../services/agent-messaging/constants.js';
import { hydrateRetentionIndex, bindOwnerRetention } from '../services/server-retention/owner.js';

/** Borrowing for the migrator must not return the ownership connection to its pool. */
function migrationConnection(connection: PoolConnection): PoolConnection {
  return new Proxy(connection, {
    get(target, property) {
      if (property === 'release') return () => {};
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function createOwnedControlPlane(options: {
  pool: Pool;
  /** Existing service facade; services discover their typed owner through this identity. */
  handle: object;
  env: Env;
  keyring: Keyring;
  prepare?: (database: PersistenceTransaction) => Promise<void>;
  committed?: (receipt: CommandReceipt, effects: readonly OutboxIntent[]) => void;
  error(error: unknown): void;
}) {
  const ownership = new ControlPlaneOwnership(options.pool, options.env.DB_DATABASE);
  const deadlines = new DeadlineQueue(options.error);
  try {
    const connection = await ownership.acquire();
    const legacyCutover = await readLegacyCutoverManifest(
      join(options.env.DATA_ROOT ?? '/app/storage', '.control-plane-legacy-drain.json'),
      options.env.DB_DATABASE,
    );
    await runBootMigrations(options.env, { getConnection: async () => migrationConnection(connection) });
    // Boot defaults/checks complete under exclusive ownership, before state is visible.
    await options.prepare?.(drizzle(connection, { schema, mode: 'default' }));
    const hydrated = await ownership.hydrate(async (held, epoch) => {
      const db = drizzle(held, { schema, mode: 'default' });
      // Host zero belongs only to in-process inference tasks. Normal startup
      // already holds the shared-store lock, proving the previous API drained
      // or exited. Remote native tasks and legacy timed grants retain their
      // separate recovery contracts; a server restart cannot release them.
      const [reconciledProviderTasks] = await db
        .delete(schema.providerAccountSessions)
        .where(
          and(
            eq(schema.providerAccountSessions.hostId, 0),
            eq(schema.providerAccountSessions.ownershipMode, 'connection'),
          ),
        );
      // A previous process cannot prove current execution from its persisted
      // lease timestamp. Keep exclusion until the exact owner reattaches.
      const [reconciledClaims] = await db
        .update(schema.agentResourceClaims)
        .set({ state: 'uncertain', uncertaintyReason: 'owner_restart', updatedAt: new Date().toISOString() })
        .where(eq(schema.agentResourceClaims.state, 'active'));
      const [reconciledRegistrations] = await db
        .update(schema.gitWorktrees)
        .set({ status: 'uncertain', uncertaintyReason: 'owner_restart', updatedAt: new Date().toISOString() })
        .where(eq(schema.gitWorktrees.status, 'active'));
      // Existing grants remain excluded after takeover. Their old timeout is
      // not proof that an offered or accepted native action did not run.
      const [reconciledDeliveries] = await db
        .update(schema.agentBusMessages)
        .set({ ownershipMode: 'connection', leaseUntil: null })
        .where(
          and(
            eq(schema.agentBusMessages.ownershipMode, 'timed'),
            inArray(schema.agentBusMessages.status, ['leased', 'accepted', 'reboot_hold']),
          ),
        );
      await db
        .update(schema.agentMessages)
        .set({ ownershipMode: 'connection', leaseUntil: null })
        .where(
          and(
            eq(schema.agentMessages.ownershipMode, 'timed'),
            inArray(schema.agentMessages.status, ['leased', 'accepted', 'reboot_hold']),
          ),
        );
      await db
        .update(schema.coordProjectCards)
        .set({ claimUncertaintyReason: 'owner_restart' })
        .where(
          and(
            isNotNull(schema.coordProjectCards.claimedAt),
            isNull(schema.coordProjectCards.claimReleasedAt),
          ),
        );
      await reconcileWorkflowOwnership(db);
      const state = await hydrateOwnerState(db, { epoch, sequence: 0n }, { keyring: options.keyring });
      const retention = await hydrateRetentionIndex(db, options.env);
      return {
        ...state,
        retention,
        reconciledClaims: reconciledClaims.affectedRows,
        reconciledRegistrations: reconciledRegistrations.affectedRows,
        reconciledDeliveries: reconciledDeliveries.affectedRows,
        reconciledProviderTasks: reconciledProviderTasks.affectedRows,
      };
    });
    const persistence = new OwnerPersistence(ownership, options.keyring);
    const commands = new CommandExecutor({
      state: hydrated.store,
      persistence,
      assertOwner: () => ownership.assertReady(),
      loseOwner: (error) => ownership.lose(error),
      committed: (receipt, effects) => options.committed?.(receipt, effects),
      notificationError: options.error,
    });
    const runtime: OwnerRuntime = {
      state: hydrated.store,
      deadlines,
      assertOwner: () => ownership.assertReady(),
      execute: (command) => commands.execute(command),
    };
    const presence = new ConnectionPresence((error) => ownership.lose(error));
    bindOwnerPresence(runtime, presence);
    bindOwnerRetention(runtime, hydrated.retention);
    const credentials = new ConnectionCredentials(runtime, presence, {
      session: options.env.AGENT_PORTAL_BRIDGE_TTL_SECONDS * 1000,
      relay: AGENT_MESSAGING_RELAY_TOKEN_SECONDS * 1000,
    });
    const legacyDrain = new LegacyDrainRegistry(
      runtime,
      captureLegacyDrainManifest(hydrated.store.snapshot(), Date.now(), legacyCutover
        ? filterLegacyCutoverManifest(legacyCutover, hydrated.store.snapshot())
        : {}),
      {
        session: options.env.AGENT_PORTAL_BRIDGE_TTL_SECONDS * 1000,
        relay: AGENT_MESSAGING_RELAY_TOKEN_SECONDS * 1000,
      },
    );
    bindOwnerRuntime(options.handle, runtime);
    let stopBoard = () => {},
      stopStateEvents = () => {};
    ownership.onLost(() => {
      stopBoard();
      stopStateEvents();
      stopHostActivity(runtime);
      legacyDrain.close();
      credentials.close();
      deadlines.close();
      presence.close();
    });
    ownership.ready();
    trackHostActivity(runtime);
    stopBoard = trackBoardOwnership(runtime);
    stopStateEvents = publishOwnerStateChanges(runtime);
    return {
      runtime,
      ownership,
      persistence,
      commands,
      deadlines,
      presence,
      credentials,
      legacyDrain,
      retention: hydrated.retention,
      hydration: hydrated.stats,
      reconciledClaims: hydrated.reconciledClaims,
      reconciledRegistrations: hydrated.reconciledRegistrations,
      reconciledDeliveries: hydrated.reconciledDeliveries,
      reconciledProviderTasks: hydrated.reconciledProviderTasks,
      async close() {
        stopBoard();
        stopStateEvents();
        await commands.drain();
        stopHostActivity(runtime);
        legacyDrain.close();
        credentials.close();
        deadlines.close();
        presence.close();
        await ownership.close();
      },
    };
  } catch (error) {
    deadlines.close();
    await ownership.close();
    throw error;
  }
}

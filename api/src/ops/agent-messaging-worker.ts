import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { messagingMaintenanceObligations, MESSAGING_MAINTENANCE_TABLES } from './maintenance-obligations.js';

/** Queue, binding, reboot and conference obligations survive an idle fleet. */
export function startAgentMessagingWorker(app: FastifyInstance, db: Database, _env: Env, _keyring: Keyring): void {
  const commands = requireOwnerMaintenanceCommands(db);
  startOwnerWorker(app, db, {
    name: 'messaging', tables: MESSAGING_MAINTENANCE_TABLES,
    select: snapshot => messagingMaintenanceObligations(snapshot, commands.facts),
    subscribe: wake => commands.subscribeFacts(wake),
    run: obligation => commands.run('messaging', obligation),
    error: error => app.log.error({ err: error }, 'owner messaging maintenance failed'),
  });
}

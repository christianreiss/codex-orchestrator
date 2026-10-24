import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { authRetentionObligations } from './maintenance-obligations.js';

/** Payload metadata supplies exact purge dates; encrypted bodies stay cold. */
export function startAuthRetentionWorker(app: FastifyInstance, db: Database): void {
  const commands = requireOwnerMaintenanceCommands(db);
  startOwnerWorker(app, db, {
    name: 'auth-retention', tables: ['authPayloads', 'authCanonicalHeads', 'providerAccounts'],
    select: authRetentionObligations,
    run: obligation => commands.run('auth-retention', obligation),
    error: error => app.log.error({ err: error }, 'owner auth retention failed'),
  });
}

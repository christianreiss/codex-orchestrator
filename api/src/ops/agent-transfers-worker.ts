import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { transferExpiryObligations } from './maintenance-obligations.js';

/** Known file deadlines plus one crash-recovery reconciliation at owner startup. */
export function startAgentTransfersWorker(app: FastifyInstance, db: Database, _env: Env): void {
  const commands = requireOwnerMaintenanceCommands(db);
  startOwnerWorker(app, db, {
    name: 'transfer-expiry', tables: ['agentTransfers'],
    select: transferExpiryObligations,
    run: obligation => commands.run('transfer-expiry', obligation),
    error: error => app.log.error({ err: error }, 'owner transfer expiry failed'),
  });
  let reconcile = true;
  startOwnerWorker(app, db, {
    name: 'transfer-orphans', tables: [],
    select: () => reconcile ? [{ key: 'startup', revision: 'startup', dueAt: 0 }] : [],
    async run(obligation) {
      const result = await commands.run('transfer-orphans', obligation);
      if (!result || 'observed' in result) reconcile = false;
      return result;
    },
    error: error => app.log.error({ err: error }, 'owner transfer crash recovery failed'),
  });
}

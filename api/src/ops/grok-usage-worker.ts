import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { grokUsageObligations } from './provider-obligations.js';

/** Account enrollment and the provider's real five-minute deadline drive work. */
export function startGrokUsageWorker(app: FastifyInstance, db: Database, _env: Env, _keyring: Keyring): void {
  const commands = requireOwnerMaintenanceCommands(db);
  startOwnerWorker(app, db, {
    name: 'grok-usage', tables: ['versions', 'providerAccounts', 'grokUsageSnapshots'],
    select: grokUsageObligations,
    run: obligation => commands.run('grok-usage', obligation),
    error: error => app.log.warn({ err: error }, 'owner Grok usage request failed'),
  });
}

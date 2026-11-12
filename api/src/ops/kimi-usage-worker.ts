import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { kimiUsageObligations } from './provider-obligations.js';

/** Account enrollment and the provider's real five-minute deadline drive work. */
export function startKimiUsageWorker(app: FastifyInstance, db: Database, _env: Env, _keyring: Keyring): void {
  const commands = requireOwnerMaintenanceCommands(db);
  startOwnerWorker(app, db, {
    name: 'kimi-usage',
    tables: ['versions', 'providerAccounts', 'kimiUsageSnapshots'],
    select: kimiUsageObligations,
    run: (obligation) => commands.run('kimi-usage', obligation),
    error: (error) => app.log.warn({ err: error }, 'owner Kimi usage request failed'),
  });
}

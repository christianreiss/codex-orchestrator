import { communicatorRegistry } from '../services/topology/communicator-registry.js';
import { requireOwnerRuntime } from '../control-plane/state/runtime.js';
import { hostActivity } from '../control-plane/state/host-activity.js';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { PORTAL_MAINTENANCE_TABLES, portalObligations } from './portal-obligations.js';

export function startAgentPortalWorker(
  app: FastifyInstance,
  db: Database,
  _env: Env,
  _keyring: Keyring,
): void {
  const commands = requireOwnerMaintenanceCommands(db);
  const graceUntil = Date.now() + 150_000;
  // Forces the startup readiness invariant even when the fleet is empty.
  commands.retention.obligations();
  startOwnerWorker(app, db, {
    name: 'portal-retention',
    tables: PORTAL_MAINTENANCE_TABLES,
    select: (snapshot) => [
      ...portalObligations(snapshot, commands.facts, graceUntil, (id) =>
        hostActivity(requireOwnerRuntime(db), id),
      ),
      ...commands.retention.obligations(),
    ],
    subscribe(wake) {
      const connections = communicatorRegistry.subscribeLifecycle(wake);
      const facts = commands.subscribeFacts(wake);
      const retention = commands.retention.subscribe(wake);
      return () => {
        connections();
        facts();
        retention();
      };
    },
    run: (work) => commands.run('portal-retention', work),
    error: (error) => app.log.error({ err: error }, 'owner portal/history retention failed'),
  });
}

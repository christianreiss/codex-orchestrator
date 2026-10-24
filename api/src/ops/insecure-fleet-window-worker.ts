import { requireOwnerRuntime } from '../control-plane/state/runtime.js';
import { pendingWithInterest, subscribeAdmissionInterest } from '../control-plane/state/admission-interest.js';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { insecureMaintenanceObligations, INSECURE_MAINTENANCE_TABLES } from './maintenance-obligations.js';

/** Absolute grant expiry and caller/approval deadlines, independent of traffic. */
export function startInsecureFleetWindowWorker(app: FastifyInstance, db: Database, _env: Env): void {
  const runtime = requireOwnerRuntime(db);
  const commands = requireOwnerMaintenanceCommands(db);
  startOwnerWorker(app, db, {
    name: 'insecure-expiry', tables: INSECURE_MAINTENANCE_TABLES,
    select: (snapshot, now) => insecureMaintenanceObligations(snapshot, now, row => pendingWithInterest(runtime, row)),
    subscribe: wake => subscribeAdmissionInterest(runtime, wake),
    run: obligation => commands.run('insecure-expiry', obligation),
    error: error => app.log.error({ err: error }, 'owner insecure access expiry failed'),
  });
}

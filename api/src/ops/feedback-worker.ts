import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../routes/index.js';
import { buildIdentity } from '../services/feedback/build-identity.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { feedbackObligations } from './provider-obligations.js';

export function startFeedbackWorker(app: FastifyInstance, ctx: RouteContext): void {
  const commands = requireOwnerMaintenanceCommands(ctx.db);
  startOwnerWorker(app, ctx.db, {
    name: 'feedback', tables: ['versions', 'feedbackPipeline', 'feedbackItems'],
    select: snapshot => feedbackObligations(snapshot, buildIdentity()),
    run: obligation => commands.run('feedback', obligation),
    error: error => app.log.warn({ err: error }, 'owner feedback job failed; retained pending work'),
  });
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { createAgentMessagingService } from '../../services/agent-messaging.js';
import { createWorkflowsService } from '../agent-messaging/workflows.js';
import { AdminEventsService } from '../../services/admin-events.js';
import type { WorkflowActor, WorkflowOperation } from '../../services/workflows/contract.js';
export async function registerAdminWorkflowRoutes(app: FastifyInstance, ctx: RouteContext) {
  const service = createWorkflowsService(ctx, createAgentMessagingService(ctx.db, ctx.env, ctx.keyring));
  const events = new AdminEventsService(ctx.db);
  const actor = (req: FastifyRequest): WorkflowActor => ({ kind: 'admin', id: String(req.admin!.user.id) });
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;
  const mutate = async (
    req: FastifyRequest,
    operation: WorkflowOperation,
    patch: Record<string, unknown> = {},
  ) => {
    const result = await service.mutate(
      operation,
      { ...((req.body as Record<string, unknown>) ?? {}), ...patch },
      actor(req),
    );
    await events.record(
      {
        type: `workflow.${operation}`,
        payload: {
          admin_user_id: req.admin!.user.id,
          run_id: result.run_id ?? null,
          workflow_id: result.workflow_id ?? null,
        },
      },
      { broadcast: false },
    );
    return result;
  };
  const guard = { preHandler: app.requireAdmin };
  app.get('/admin/workflow-definitions/state', guard, () => service.state());
  app.post('/admin/workflow-definitions/state', guard, (req) => mutate(req, 'state'));
  app.get('/admin/workflow-definitions', guard, (req) => service.list(req.query));
  app.post('/admin/workflow-definitions', guard, (req) => mutate(req, 'create'));
  app.get('/admin/workflow-definitions/:id', guard, (req) => service.get(id(req)));
  app.get('/admin/workflow-definitions/:id/versions', guard, (req) => service.versions(id(req), req.query));
  app.get('/admin/workflow-definitions/:id/versions/:version', guard, (req) =>
    service.get(
      id(req),
      z.coerce
        .number()
        .int()
        .positive()
        .parse((req.params as { version: string }).version),
    ),
  );
  app.post('/admin/workflow-definitions/:id/revise', guard, (req) =>
    mutate(req, 'revise', { workflow_id: id(req) }),
  );
  app.post('/admin/workflow-definitions/:id/archive', guard, (req) =>
    mutate(req, 'archive', { workflow_id: id(req), action: 'archive' }),
  );
  app.post('/admin/workflow-definitions/:id/restore', guard, (req) =>
    mutate(req, 'archive', { workflow_id: id(req), action: 'restore' }),
  );
  app.post('/admin/workflow-definitions/:id/revert', guard, (req) =>
    mutate(req, 'revert', { workflow_id: id(req) }),
  );
  app.get('/admin/workflow-runs', guard, (req) => service.runList(req.query));
  app.post('/admin/workflow-runs', guard, (req) => mutate(req, 'run_create'));
  app.get('/admin/workflow-runs/:id', guard, (req) => service.runGet(id(req), req.query));
  app.get('/admin/workflow-runs/:id/events', guard, (req) => service.events(id(req), req.query));
  app.get('/admin/workflow-runs/:id/report', guard, (req) => service.report(id(req)));
  app.get('/admin/workflow-runs/:id/tasks/:taskId', guard, (req) =>
    service.taskDetail(id(req), (req.params as { taskId: string }).taskId, req.query),
  );
  app.post('/admin/workflow-runs/:id/control', guard, (req) =>
    mutate(req, 'run_control', { run_id: id(req) }),
  );
  app.post('/admin/workflow-runs/:id/prepare-cancel', guard, (req) =>
    mutate(req, 'prepare_cancel', { run_id: id(req) }),
  );
}

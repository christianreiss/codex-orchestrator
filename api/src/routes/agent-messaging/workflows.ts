import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UnauthorizedError } from '../../http/errors.js';
import type { AgentMessagingService } from '../../services/agent-messaging.js';
import { WorkflowsService } from '../../services/workflows.js';
import type { RouteContext } from '../index.js';
import { SettingsService } from '../../services/settings.js';
import { createWorkflowCollaboration } from '../../services/agent-messaging/workflows.js';
import type { WorkflowActor, WorkflowOperation } from '../../services/workflows/contract.js';

/** Shared by bridge and admin routes: every mutation gets transactional collaboration hooks. */
export function createWorkflowsService(ctx: RouteContext, messaging: AgentMessagingService) {
  return new WorkflowsService({ db: ctx.db, settings: new SettingsService(ctx.db), keyring: ctx.keyring,
    publicBaseUrl: ctx.env.PUBLIC_BASE_URL, collaboration: createWorkflowCollaboration(messaging, ctx.env.PUBLIC_BASE_URL) });
}

/** Session/bridge authentication supplies identity; no caller-supplied actor fields are accepted. */
export function registerWorkflowBridgeRoutes(app: FastifyInstance, workflows: WorkflowsService, messaging: AgentMessagingService) {
  const actor = async (req: FastifyRequest): Promise<WorkflowActor> => {
    const token = req.headers['x-agent-bridge-token'];
    if (typeof token !== 'string' || !token) throw new UnauthorizedError('Bridge credential required', 'agent_bridge_token_required');
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const { session } = await messaging.authenticateBridge(id, token);
    if (!session.agentBusAddressId) throw new UnauthorizedError('Bound workflow actor required');
    return { kind: 'agent', id: session.agentBusAddressId, address_id: session.agentBusAddressId,
      session_id: session.id, binding_generation: session.bindingGeneration, host_id: session.hostId,
      engine: session.engine, name: session.launchName ?? undefined };
  };
  const operations: Record<string, WorkflowOperation> = {
    create: 'create', revise: 'revise', archive: 'archive', 'run-create': 'run_create',
    'run-control': 'run_control', invite: 'invite', membership: 'membership',
    'task-claim': 'task_claim', 'task-update': 'task_update', 'run-note': 'run_note',
    'run-finish': 'run_finish', 'run-evaluate': 'run_evaluate',
  };
  for (const [suffix, operation] of Object.entries(operations)) {
    app.post(`/host/agent-sessions/:id/agent-messaging/workflows/${suffix}`, async req => {
      const authenticated = await actor(req);
      return workflows.mutate(operation, req.body ?? {}, authenticated);
    });
  }
  app.post('/host/agent-sessions/:id/agent-messaging/workflows/run-current', async req => {
    const authenticated = await actor(req);
    z.object({}).strict().parse(req.body ?? {});
    await messaging.coordinationTransaction(authenticated.session_id!, (req.headers['x-agent-bridge-token'] as string), tx => messaging.workflowTarget(tx, authenticated.address_id!));
    return workflows.runCurrent(authenticated);
  });
}

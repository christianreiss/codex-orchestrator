import { z } from 'zod';
import { NotFoundError } from '../../http/errors.js';
import { SettingsService } from '../settings.js';
import { WorkflowsService } from '../workflows.js';
import { pageSchema, workflowMutationSchemas, type WorkflowActor } from '../workflows/contract.js';
import { modelSafe } from './contracts.js';
import { define } from './tool-definition.js';
import type { ChattyTool, ToolContext } from './tools.js';

const identifier = z.string().min(1).max(64);
const runId = z.string().uuid();
const taskId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const page = pageSchema.shape;
const service = (c: ToolContext) =>
  new WorkflowsService({
    db: c.db,
    settings: new SettingsService(c.db),
    keyring: c.keyring,
    publicBaseUrl: c.env.PUBLIC_BASE_URL,
  });
const actor = (c: ToolContext): WorkflowActor => ({ kind: 'admin', id: String(c.actor.userId) });
const href = () => '/admin/workflows';
const definitionSnapshot = (c: ToolContext, a: { workflow_id: string }) => service(c).get(a.workflow_id);

/** Workflow definitions are editable; execution remains an explicit separate surface. */
export function workflowTools(): ChattyTool[] {
  return [
    define(
      'workflow_state_read',
      'Read workflow availability and Agent Messaging readiness.',
      'workflows.read',
      {},
      async (c) => modelSafe(await service(c).state()),
    ),
    define(
      'workflow_state_set',
      'Enable or suspend new workflow execution; existing runs may finish.',
      'workflows.manage',
      workflowMutationSchemas.state.shape,
      async (c, a) => modelSafe(await service(c).mutate('state', a, actor(c))),
      { confirm: true, snapshot: (c) => service(c).state(), href },
    ),
    define(
      'workflows_list',
      'Find workflow definitions, including archived definitions, with a bounded cursor.',
      'workflows.read',
      { ...page, search: z.string().max(255).optional(), status: z.enum(['active', 'archived']).optional() },
      async (c, a) => modelSafe(await service(c).list(a)),
    ),
    define(
      'workflow_read',
      'Read a workflow by ID or slug, optionally at an immutable version.',
      'workflows.read',
      { workflow_id: identifier, version: z.number().int().positive().optional() },
      async (c, a) => modelSafe(await service(c).get(a.workflow_id, a.version)),
    ),
    define(
      'workflow_versions',
      'Read paginated immutable workflow definitions and revision history.',
      'workflows.read',
      { workflow_id: identifier, ...page },
      async (c, { workflow_id, ...a }) => modelSafe(await service(c).versions(workflow_id, a)),
    ),
    define(
      'workflow_create',
      'Create a reusable workflow definition. This does not create or dispatch a run.',
      'workflows.manage',
      workflowMutationSchemas.create.shape,
      async (c, a) => modelSafe(await service(c).mutate('create', a, actor(c))),
      {
        confirm: true,
        href,
        snapshot: async (c, a) => {
          try {
            return await service(c).get(a.slug);
          } catch (error) {
            if (error instanceof NotFoundError && error.code === 'workflow_not_found') return null;
            throw error;
          }
        },
      },
    ),
    define(
      'workflow_revise',
      'Publish a validated workflow definition revision using its expected current version.',
      'workflows.manage',
      workflowMutationSchemas.revise.omit({ source_run_id: true }).shape,
      async (c, a) => modelSafe(await service(c).mutate('revise', a, actor(c))),
      { confirm: true, snapshot: definitionSnapshot, href },
    ),
    ...(['archive', 'restore'] as const).map((action) =>
      define(
        `workflow_${action}`,
        action === 'archive'
          ? 'Archive a workflow definition without removing its history.'
          : 'Restore an archived workflow definition.',
        'workflows.manage',
        workflowMutationSchemas.archive.omit({ action: true }).shape,
        async (c, a) => modelSafe(await service(c).mutate('archive', { ...a, action }, actor(c))),
        { confirm: true, snapshot: definitionSnapshot, href },
      ),
    ),
    define(
      'workflow_revert',
      'Publish a prior workflow version as a new current revision; retain history.',
      'workflows.manage',
      workflowMutationSchemas.revert.shape,
      async (c, a) => modelSafe(await service(c).mutate('revert', a, actor(c))),
      {
        confirm: true,
        snapshot: async (c, a) => ({
          current: await service(c).get(a.workflow_id),
          source: await service(c).get(a.workflow_id, a.version),
        }),
        href,
      },
    ),
    define(
      'workflow_runs_list',
      'Read bounded workflow runs filtered by definition, status, outcome or participant.',
      'workflows.read',
      {
        ...page,
        workflow_id: identifier.optional(),
        status: z.enum(['pending', 'running', 'paused', 'blocked', 'evaluating', 'completed']).optional(),
        outcome: z.enum(['succeeded', 'partial', 'failed', 'canceled', 'unknown']).optional(),
        agent_address_id: runId.optional(),
        evaluation: z.enum(['pending', 'final']).optional(),
        search: z.string().max(255).optional(),
      },
      async (c, a) => modelSafe(await service(c).runList(a)),
    ),
    define(
      'workflow_run_read',
      'Read workflow run state, task page, membership and evaluation metadata.',
      'workflows.read',
      { run_id: runId, ...page },
      async (c, { run_id, ...a }) => modelSafe(await service(c).runGet(run_id, a)),
    ),
    define(
      'workflow_run_events',
      'Read the next page of durable workflow run events by sequence cursor.',
      'workflows.read',
      { run_id: runId, ...page },
      async (c, { run_id, ...a }) => modelSafe(await service(c).events(run_id, a)),
    ),
    define(
      'workflow_run_report',
      'Read the workflow run report and its pinned definition.',
      'workflows.read',
      { run_id: runId },
      async (c, a) => modelSafe(await service(c).report(a.run_id)),
    ),
    define(
      'workflow_run_task_read',
      'Read task attempts, evidence and required knowledge checks for a workflow run.',
      'workflows.read',
      { run_id: runId, task_id: taskId, ...page },
      async (c, { run_id, task_id, ...a }) => modelSafe(await service(c).taskDetail(run_id, task_id, a)),
    ),
  ];
}

import { ProjectContentService } from '../project-content.js';
import { createWorkflowsService } from '../../routes/agent-messaging/workflows.js';
import { createAgentMessagingService } from '../agent-messaging.js';
import { FeedbackService } from '../feedback.js';
import { SettingsService } from '../settings.js';
import { z } from 'zod';
import type { RouteContext } from '../../routes/index.js';
import { ProjectsService } from '../projects.js';
import { SharedMemoriesService } from '../shared-memories.js';
import { SkillsService } from '../skills.js';
import { SecretsService } from '../secrets.js';
import { ExternalClientsService } from '../external-clients/index.js';
import { agentTaskResults, externalClients } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../../security/secret-box.js';
import { allowed, targetAllowed, type OperationPolicy } from './policy.js';
import { ConnectorOAuth } from './oauth.js';
import { ForbiddenError } from '../../http/errors.js';
import { addOwnerResponseProof } from '../../control-plane/state/runtime.js';

interface Operation extends OperationPolicy {
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  run: (a: Record<string, unknown>, auth: ReturnType<ConnectorOAuth['authority']>) => Promise<unknown>;
}
export class ConnectorCatalog {
  readonly operations: Record<string, Operation>;
  constructor(
    readonly oauth: ConnectorOAuth,
    ctx: RouteContext,
  ) {
    const projects = new ProjectsService(ctx.db),
      memory = new SharedMemoriesService(ctx.db),
      skills = new SkillsService(ctx.db),
      secrets = new SecretsService({ db: ctx.db, keyring: ctx.keyring });
    const projectContent = new ProjectContentService(ctx.db, projects),
      workflows = createWorkflowsService(ctx, createAgentMessagingService(ctx.db, ctx.env, ctx.keyring)),
      feedback = new FeedbackService(ctx.db, ctx.keyring);
    const external = new ExternalClientsService(ctx.db, ctx.env, ctx.keyring);
    const project = { project: z.string().min(1) },
      host = { host_id: z.number().int().positive() };
    this.operations = {
      hosts_list: {
        category: 'hosts',
        capability: 'hosts.read',
        description: 'List explicitly authorized managed hosts.',
        schema: z.object({}),
        run: async (_, auth) => ({
          hosts: oauth.store
            .snapshot()
            .hosts.all()
            .filter((h) => targetAllowed(auth.grant.scope, auth.policy.ceiling, 'hosts', h.id))
            .map((h) => ({ id: h.id, hostname: h.fqdn, status: h.status })),
        }),
      },
      projects_list: {
        category: 'projects',
        capability: 'projects.read',
        description: 'List explicitly authorized projects.',
        schema: z.object({}),
        run: async (_, auth) => ({
          projects: (await projects.list()).projects.filter((p) =>
            targetAllowed(auth.grant.scope, auth.policy.ceiling, 'projects', p.slug),
          ),
        }),
      },
      project_read: {
        category: 'projects',
        capability: 'projects.read',
        description: 'Read an authorized project summary.',
        schema: z.object(project),
        run: async (a) => projects.summary(String(a.project)),
      },
      project_update: {
        category: 'projects',
        capability: 'projects.manage',
        write: true,
        description: 'Update an authorized project description.',
        schema: z.object({ ...project, about: z.record(z.unknown()) }),
        run: async (a) => projects.updateAbout(String(a.project), { about: a.about }),
      },
      project_delete: {
        category: 'projects',
        capability: 'projects.manage',
        write: true,
        sensitive: 'delete',
        description: 'Permanently delete an authorized project.',
        schema: z.object(project),
        run: async (a) => projects.deleteBySlug(String(a.project)),
      },
      project_notes: {
        category: 'projects',
        capability: 'projects.read',
        description: 'Read notes in an authorized project.',
        schema: z.object(project),
        run: async (a) => projectContent.listNotes(String(a.project)),
      },
      project_note_write: {
        category: 'projects',
        capability: 'projects.manage',
        write: true,
        description: 'Create or update a note in an authorized project.',
        schema: z.object({
          ...project,
          id: z.number().int().positive().optional(),
          header: z.string().max(255),
          body: z.string().max(32000),
        }),
        run: async (a) =>
          projectContent.upsertNote(String(a.project), a.id ? Number(a.id) : null, {
            header: a.header,
            body: a.body,
          }),
      },
      workflow_list: {
        category: 'workflows',
        capability: 'workflows.read',
        global: true,
        description: 'Read fleet workflow definitions. Does not start work.',
        schema: z.object({}),
        run: async () => workflows.list(),
      },
      workflow_get: {
        category: 'workflows',
        capability: 'workflows.read',
        global: true,
        description: 'Read a workflow definition by ID.',
        schema: z.object({ id: z.string() }),
        run: async (a) => workflows.get(String(a.id)),
      },
      feedback_list: {
        category: 'feedback',
        capability: 'feedback.read',
        global: true,
        description: 'Read fleet feedback metadata.',
        schema: z.object({}),
        run: async () => ({
          items: oauth.store
            .snapshot()
            .table('feedbackItems')
            .all()
            .map((r) => ({ id: r.id, title: r.title, status: r.status, component: r.component })),
        }),
      },
      feedback_submit: {
        category: 'feedback',
        capability: 'feedback.manage',
        write: true,
        global: true,
        description: 'Submit an attributed orchestrator feedback report.',
        schema: z.object({
          client_request_id: z.string().uuid(),
          title: z.string().max(255),
          component: z.string().max(100),
          description: z.string().max(16000),
          type: z.enum(['bug', 'feature', 'feedback']),
        }),
        run: async (a, auth) =>
          feedback.submit(a, { kind: 'admin', admin_user_id: auth.user.id, host_id: null, engine: null }),
      },
      skill_read: {
        category: 'content',
        capability: 'content.read',
        global: true,
        description: 'Read a fleet skill manifest.',
        schema: z.object({ slug: z.string() }),
        run: async (a) => skills.find(String(a.slug)),
      },
      skill_write: {
        category: 'content',
        capability: 'content.manage',
        write: true,
        global: true,
        description: 'Store a fleet skill manifest.',
        schema: z.object({ slug: z.string(), manifest: z.string().min(1).max(100000) }),
        run: async (a) => skills.store({ slug: a.slug, manifest: a.manifest }),
      },
      shared_memory_list: {
        category: 'memory',
        capability: 'memory.read',
        global: true,
        description: 'List fleet-wide shared memory. Requires explicit global scope.',
        schema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
        run: async (a) => memory.list(a),
      },
      shared_memory_read: {
        category: 'memory',
        capability: 'memory.read',
        global: true,
        description: 'Read fleet-wide shared memory.',
        schema: z.object({ slug: z.string() }),
        run: async (a) => memory.read(a),
      },
      shared_memory_write: {
        category: 'memory',
        capability: 'memory.write',
        write: true,
        global: true,
        description: 'Write shared memory with optimistic concurrency.',
        schema: z.object({
          slug: z.string(),
          content: z.string().max(100000),
          expected_sha256: z.string().optional(),
        }),
        run: async (a) => memory.write(a),
      },
      skills_list: {
        category: 'content',
        capability: 'content.read',
        global: true,
        description: 'List fleet skill metadata.',
        schema: z.object({}),
        run: async () => ({ skills: (await skills.list()).map((s) => ({ slug: s.slug })) }),
      },
      secrets_list: {
        category: 'content',
        capability: 'secrets.read_metadata',
        sensitive: 'secrets.metadata',
        global: true,
        description: 'List secret metadata, never values.',
        schema: z.object({}),
        run: async () => secrets.list(),
      },
      secret_reveal: {
        category: 'content',
        capability: 'secrets.reveal',
        sensitive: 'secrets.reveal',
        global: true,
        description: 'Reveal a secret value. Requires a separate sensitive grant.',
        schema: z.object({ id: z.number().int().positive() }),
        run: async (a) => secrets.revealById(Number(a.id)),
      },
      agents_list: {
        category: 'coordination',
        capability: 'agent_portal.read',
        description: 'List sessions on an explicitly authorized host.',
        schema: z.object(host),
        run: async (a) => ({
          agents: oauth.store
            .snapshot()
            .table('agentSessions')
            .all()
            .filter((s) => s.hostId === a.host_id)
            .map((s) => ({
              id: s.id,
              host_id: s.hostId,
              name: s.launchName,
              engine: s.engine,
              status: s.status,
            })),
        }),
      },
      work_result: {
        category: 'coordination',
        capability: 'agent_messaging.reveal_content',
        description:
          'Read explicit durable results for work delegated by this connection. Transport acceptance alone is unknown.',
        schema: z.object({ message_id: z.string().uuid() }),
        run: async (a, auth) => {
          const state = oauth.store.snapshot(),
            work = oauth.store.get<{ grantId: string; hostId: number }>(`work:${String(a.message_id)}`);
          if (
            !work ||
            work.grantId !== auth.grant.id ||
            !targetAllowed(auth.grant.scope, auth.policy.ceiling, 'hosts', work.hostId)
          )
            throw new ForbiddenError('Work outside connector scope');
          const message = state.messages.get(String(a.message_id)),
            results = await ctx.db
              .select()
              .from(agentTaskResults)
              .where(eq(agentTaskResults.messageId, String(a.message_id)));
          return {
            message_id: a.message_id,
            delivery_status: message?.status ?? 'unknown',
            results: results.map((r) => ({
              status: r.status,
              content: JSON.parse(decrypt(r.bodyEnc, ctx.keyring)),
              created_at: r.createdAt,
            })),
          };
        },
      },
      agent_delegate: {
        category: 'coordination',
        capability: 'agent_portal.manage',
        write: true,
        sensitive: 'delegate',
        description:
          'Delegate potentially arbitrary host work to a managed agent. Agent authority applies; this is command execution, not an ordinary write.',
        schema: z.object({
          ...host,
          session_id: z.string().uuid(),
          client_message_id: z.string().uuid(),
          content: z.string().min(1).max(16000),
        }),
        run: async (a, auth) => {
          const session = oauth.store.snapshot().table('agentSessions').get(String(a.session_id));
          if (!session || session.hostId !== a.host_id)
            throw new ForbiddenError('Session outside selected host');
          if (!session.agentBusAddressId) throw new ForbiddenError('Agent has no messaging address');
          const name = `OAuth ${auth.grant.id}`;
          let bridge = (await external.list()).find((c) => c.name === name);
          if (!bridge) {
            try {
              bridge = (
                await external.create({
                  name,
                  description: `${auth.grant.provider} user ${auth.user.id}`,
                  trust: 'trusted',
                  adminId: auth.user.id,
                })
              ).client;
            } catch (error) {
              bridge = (await external.list()).find((c) => c.name === name);
              if (!bridge) throw error;
            }
          }
          const [row] = await ctx.db.select().from(externalClients).where(eq(externalClients.id, bridge.id));
          if (!row) throw new ForbiddenError('Connector messaging identity missing');
          return external.bridge.send(row, {
            kind: 'request',
            connector: {
              grantId: auth.grant.id,
              userId: auth.user.id,
              hostId: session.hostId,
              sessionId: session.id,
            },
            to: `agent:${session.agentBusAddressId}`,
            clientMessageId: String(a.client_message_id),
            content: `[OAuth connector ${auth.grant.provider}; user ${auth.user.id}; grant ${auth.grant.id}]\n${String(a.content)}`,
            deliveryClass: 'coordination',
          });
        },
      },
    };
  }
  names(auth: ReturnType<ConnectorOAuth['authority']>): string[] {
    return Object.keys(this.operations).filter((n) =>
      allowed(auth.grant.scope, auth.policy.ceiling, auth.user.accessLevel, n, this.operations[n]!),
    );
  }
  async call(name: string, input: unknown, auth: ReturnType<ConnectorOAuth['authority']>) {
    const op = this.operations[name];
    if (!op || !auth.grant.operations.includes(name) || !this.names(auth).includes(name))
      throw new ForbiddenError('Tool not granted');
    const a = op.schema.strict().parse(input);
    for (const [field, kind] of [
      ['host_id', 'hosts'],
      ['project', 'projects'],
    ] as const)
      if (
        a[field] !== undefined &&
        !targetAllowed(auth.grant.scope, auth.policy.ceiling, kind, a[field] as string | number)
      )
        throw new ForbiddenError('Target outside connector scope');
    addOwnerResponseProof('connector-target', (snapshot) => {
      const current = this.oauth.authority(auth.grant.id, snapshot);
      if (!allowed(current.grant.scope, current.policy.ceiling, current.user.accessLevel, name, op))
        throw new ForbiddenError('Permission changed');
    });
    const module =
      op.category === 'projects'
        ? 'projects_module_enabled'
        : op.category === 'workflows'
          ? 'workflows_enabled'
          : op.category === 'feedback'
            ? 'feedback_enabled'
            : name.startsWith('secret')
              ? 'secrets_module_enabled'
              : null;
    if (module && !(await new SettingsService(this.oauth.store.db).getFlag(module, false)))
      throw new ForbiddenError('Feature module disabled');
    return op.run(a, auth);
  }
  list(auth: ReturnType<ConnectorOAuth['authority']>) {
    return this.names(auth)
      .filter((n) => auth.grant.operations.includes(n))
      .map((name) => ({
        name,
        description: this.operations[name]!.description,
        inputSchema: jsonSchema(this.operations[name]!.schema),
        annotations: {
          readOnlyHint: !this.operations[name]!.write,
          destructiveHint: !!this.operations[name]!.sensitive,
          openWorldHint: true,
        },
      }));
  }
}
function jsonSchema(schema: z.ZodObject<z.ZodRawShape>) {
  const properties: Record<string, unknown> = {},
    required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    let v = value;
    if (!v.isOptional()) required.push(key);
    if (v instanceof z.ZodOptional) v = v.unwrap();
    properties[key] =
      v instanceof z.ZodNumber
        ? { type: 'integer' }
        : v instanceof z.ZodString
          ? { type: 'string' }
          : v instanceof z.ZodEnum
            ? { type: 'string', enum: v.options }
            : { type: 'object' };
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

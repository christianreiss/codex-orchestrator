/** Durable workflow facade. Authentication adapters provide actors, never request bodies. */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import {
  agentBusAddresses,
  agentSessions,
  workflowMutations,
  workflowRuns,
  workflowRunTasks,
  workflowRunMembers,
  workflowRunInvitations,
  workflowRunEvaluations,
  workflowRunEvents,
  workflowTaskAttempts,
  workflows,
  workflowVersions,
  versions as settingsRows,
} from '../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '../http/errors.js';
import type { Keyring } from '../security/keyring.js';
import { encrypt, decrypt } from '../security/secret-box.js';
import { isTruthyFlagValue, type SettingsService } from './settings.js';
import { wsPublisher } from '../ws/publisher.js';
import { AGENT_MESSAGING_ENABLED_KEY } from './agent-messaging/constants.js';
import {
  WORKFLOWS_ENABLED_KEY,
  canonical,
  digest,
  pageSchema,
  workflowMutationSchemas,
  type WorkflowActor,
  type WorkflowCollaboration,
  type WorkflowDocument,
  type WorkflowOperation,
  type MutationInput,
  type WorkflowTx,
} from './workflows/contract.js';
import {
  dbNow,
  definition,
  expect,
  lockRun,
  materializeExpiry,
  publish,
  requireAgent,
  runView,
  compactRunMutation,
  taskView,
  type Session,
} from './workflows/store.js';
import { requireWorkflowProtocol } from './workflows/contract.js';
import { createRun, runControl, runNote, finishRun, prepareCancel } from './workflows/runs.js';
import { taskClaim, taskUpdate } from './workflows/tasks.js';
import { knowledgeChecks, knowledgeUri, requiredKnowledge } from './workflows/knowledge.js';
import { invite, membership, invitationView } from './workflows/members.js';
import { evaluateRun } from './workflows/evaluation.js';
export type { WorkflowActor, WorkflowCollaboration, WorkflowOperation } from './workflows/contract.js';
export interface WorkflowsServiceDeps {
  db: Database;
  settings: SettingsService;
  keyring: Keyring;
  publicBaseUrl?: string;
  collaboration?: WorkflowCollaboration;
}
export class WorkflowsService {
  private readonly baseUrl: string;
  constructor(private readonly deps: WorkflowsServiceDeps) {
    this.baseUrl = (deps.publicBaseUrl ?? '').replace(/\/$/, '');
  }
  isEnabled() {
    return this.deps.settings.getFlag(WORKFLOWS_ENABLED_KEY, false);
  }
  async state() {
    const [enabled, messagingEnabled] = await Promise.all([
      this.isEnabled(),
      this.deps.settings.getFlag(AGENT_MESSAGING_ENABLED_KEY, false),
    ]);
    return {
      enabled,
      protocol_version: 2,
      draining: true,
      messaging_enabled: messagingEnabled,
      unavailable_reason: messagingEnabled
        ? null
        : 'Agent Messaging is disabled. Definitions and prepared runs remain manageable; enable Agent Messaging for agent execution and invitations.',
    };
  }
  setEnabled(enabled: boolean, actor: WorkflowActor, clientRequestId: string) {
    return this.mutate('state', { enabled, client_request_id: clientRequestId }, actor);
  }
  private async authenticate(tx: WorkflowTx, actor: WorkflowActor) {
    if (actor.kind === 'admin') return;
    requireAgent(actor);
    const [address] = await tx
      .select()
      .from(agentBusAddresses)
      .where(eq(agentBusAddresses.id, actor.address_id!))
      .for('update');
    const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, actor.session_id!));
    if (
      !address ||
      !session ||
      !address.enabled ||
      address.archivedAt ||
      address.currentSessionId !== actor.session_id ||
      address.bindingGeneration !== actor.binding_generation ||
      session.agentBusAddressId !== actor.address_id ||
      session.bindingGeneration !== actor.binding_generation ||
      session.endedAt ||
      session.hostId !== actor.host_id ||
      session.engine !== actor.engine
    )
      throw new ForbiddenError('Agent binding is no longer current', 'workflow_binding_changed');
    actor.protocol_version = Number((session.adapterCapabilities as Record<string, unknown> | null)?.workflow_protocol_version ?? 0);
  }
  async mutate<K extends WorkflowOperation>(
    operation: K,
    body: unknown,
    actor: WorkflowActor,
  ): Promise<Record<string, unknown>> {
    const schema = workflowMutationSchemas[operation];
    if (!schema) throw new NotFoundError('Workflow operation not found');
    const input = schema.parse(body);
    const result = await this.deps.db.transaction(async (tx) => {
      // Shared messaging lock precedes address/run/task locks. No network I/O here.
      if (this.deps.collaboration) await this.deps.collaboration.lock(tx, actor);
      await this.authenticate(tx, actor);
      const now = await dbNow(tx),
        actorKey =
          actor.kind === 'agent'
            ? `agent:${actor.address_id}:${actor.session_id}:${actor.binding_generation}`
            : `admin:${actor.id}`;
      const hash = digest(input);
      const requestId = input.client_request_id;
      await tx
        .insert(workflowMutations)
        .values({
          id: randomUUID(),
          actorKey,
          operation,
          clientRequestId: requestId,
          payloadHash: hash,
          createdAt: now,
        })
        .onDuplicateKeyUpdate({ set: { id: sql`${workflowMutations.id}` } });
      const [receipt] = await tx
        .select()
        .from(workflowMutations)
        .where(
          and(
            eq(workflowMutations.actorKey, actorKey),
            eq(workflowMutations.operation, operation),
            eq(workflowMutations.clientRequestId, requestId),
          ),
        )
        .for('update');
      if (!receipt) throw new ServiceUnavailableError('Mutation receipt unavailable');
      if (receipt.payloadHash !== hash)
        throw new ConflictError(
          'Request UUID was already used with different content',
          'workflow_idempotency_conflict',
        );
      if (receipt.response)
        return {
          ...receipt.response,
          ...(receipt.secretResponse ? JSON.parse(decrypt(receipt.secretResponse, this.deps.keyring)) : {}),
        };
      const [moduleFlag] = await tx
        .select()
        .from(settingsRows)
        .where(eq(settingsRows.name, WORKFLOWS_ENABLED_KEY))
        .for('update');
      if (
        ['run_create', 'invite'].includes(operation) ||
        (actor.kind === 'agent' && ['create', 'revise', 'archive', 'revert'].includes(operation))
      ) {
        if (!isTruthyFlagValue(moduleFlag?.version, false))
          throw new ConflictError('Workflows are disabled; existing runs may finish', 'workflows_disabled');
      }
      const ctx: Session = { tx, actor, now };
      let out: Record<string, unknown>;
      if (operation === 'state') {
        if (actor.kind !== 'admin')
          throw new ForbiddenError(
            'Only an operator may switch workflow availability',
            'workflow_admin_required',
          );
        const enabled = (input as MutationInput<'state'>).enabled;
        await tx
          .insert(settingsRows)
          .values({ name: WORKFLOWS_ENABLED_KEY, version: enabled ? '1' : '0', updatedAt: now })
          .onDuplicateKeyUpdate({ set: { version: enabled ? '1' : '0', updatedAt: now } });
        out = { enabled, protocol_version: 2, draining: true };
      } else if (operation === 'create') {
        const d = input as MutationInput<'create'>,
          id = randomUUID(),
          versionId = randomUUID();
        const duplicate = await tx
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.slug, d.slug));
        if (duplicate.length)
          throw new ConflictError('Workflow slug already exists', 'workflow_slug_conflict');
        await tx.insert(workflows).values({
          id,
          slug: d.slug,
          status: 'active',
          currentVersionId: versionId,
          title: d.document.title,
          summary: d.document.summary,
          actor: { ...actor },
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(workflowVersions).values({
          id: versionId,
          workflowId: id,
          version: 1,
          document: { ...d.document },
          sha256: digest(d.document),
          reason: d.reason,
          diff: [],
          actor: { ...actor },
          createdAt: now,
        });
        out = {
          workflow_id: id,
          slug: d.slug,
          status: 'active',
          version: 1,
          control_version: 1,
          document: d.document,
          sha256: digest(d.document),
          reason: d.reason,
          created_at: now,
          updated_at: now,
        };
      } else if (operation === 'revise' || operation === 'revert') {
        const d = input as MutationInput<'revise'> | MutationInput<'revert'>;
        const workflow = await definition(tx, d.workflow_id, true);
        let document: WorkflowDocument;
        if ('document' in d) document = d.document;
        else {
          const [source] = await tx
            .select()
            .from(workflowVersions)
            .where(
              and(eq(workflowVersions.workflowId, workflow.id), eq(workflowVersions.version, d.version)),
            );
          if (!source) throw new NotFoundError('Version not found', 'workflow_version_not_found');
          document = source.document as WorkflowDocument;
        }
        if ('source_run_id' in d && d.source_run_id)
          throw new ForbiddenError(
            'Source run revisions are published only by run evaluation',
            'workflow_evaluation_required',
          );
        const revision = await publish(ctx, workflow, document, d.reason, d.expected_workflow_version);
        out = {
          workflow_id: workflow.id,
          slug: workflow.slug,
          status: workflow.status,
          version: revision.version.version,
          control_version: workflow.controlVersion + (revision.changed ? 1 : 0),
          document,
          sha256: revision.version.sha256,
          reason: d.reason,
          changed: revision.changed,
        };
      } else if (operation === 'archive') {
        const d = input as MutationInput<'archive'>;
        const workflow = await definition(tx, d.workflow_id, true);
        expect(workflow.currentVersion, d.expected_workflow_version, 'workflow_version_conflict');
        expect(workflow.controlVersion, d.expected_control_version, 'workflow_control_version_conflict');
        const status = d.action === 'archive' ? 'archived' : 'active';
        await tx
          .update(workflows)
          .set({ status, controlVersion: workflow.controlVersion + 1, updatedAt: now })
          .where(eq(workflows.id, workflow.id));
        out = {
          workflow_id: workflow.id,
          status,
          version: workflow.currentVersion,
          control_version: workflow.controlVersion + 1,
        };
      } else if (operation === 'run_create') {
        out = runView(await createRun(ctx, input as MutationInput<'run_create'>), this.baseUrl);
      } else {
        const run = await lockRun(ctx, (input as { run_id: string }).run_id);
        if (run.preparation) requireWorkflowProtocol(ctx.actor);
        if (run.status !== 'completed') await materializeExpiry(ctx, run);
        let extra: Record<string, unknown> = {};
        switch (operation) {
          case 'run_control':
            await runControl(ctx, run, input as MutationInput<'run_control'>, this.deps.collaboration);
            break;
          case 'task_claim':
            extra = await taskClaim(ctx, run, input as MutationInput<'task_claim'>);
            break;
          case 'task_update':
            extra = await taskUpdate(ctx, run, input as MutationInput<'task_update'>);
            break;
          case 'run_note':
            extra = await runNote(ctx, run, input as MutationInput<'run_note'>);
            break;
          case 'run_finish':
            await finishRun(ctx, run, input as MutationInput<'run_finish'>);
            break;
          case 'run_evaluate': {
            const r = await evaluateRun(
              ctx,
              run,
              input as MutationInput<'run_evaluate'>,
              this.deps.collaboration,
            );
            extra = { evaluation: r.evaluation, ...('conflict' in r ? { _workflow_error: r.conflict } : {}) };
            break;
          }
          case 'invite':
            extra = await invite(
              ctx,
              run,
              input as MutationInput<'invite'>,
              this.deps.collaboration,
              runView(run, this.baseUrl).report_url,
            );
            break;
          case 'membership':
            extra = await membership(ctx, run, input as MutationInput<'membership'>, this.deps.collaboration);
            break;
          case 'prepare_cancel':
            await prepareCancel(ctx, run, input as MutationInput<'prepare_cancel'>);
            break;
          default:
            throw new NotFoundError('Workflow operation not found');
        }
        out = { ...runView(run, this.baseUrl), ...extra };
        if (operation === 'invite' || operation === 'membership') {
          const { status: detailStatus, created_at: _detailCreatedAt, ...identifiers } = extra;
          out = {
            ...runView(run, this.baseUrl),
            ...identifiers,
            ...(operation === 'invite'
              ? { invitation: extra, invitation_status: detailStatus ?? null }
              : { membership: extra, membership_status: detailStatus ?? null }),
          };
        }

        // Task version/status are distinct from the enclosing run control version/status.
        if (operation === 'task_claim' || operation === 'task_update')
          out = {
            ...runView(run, this.baseUrl),
            task: extra,
            ...('claim_token' in extra
              ? { claim_token: extra.claim_token, claim_generation: extra.claim_generation }
              : {}),
          };
      }
      const secrets: Record<string, unknown> = {};
      if (out.claim_token) {
        secrets.claim_token = out.claim_token;
        delete out.claim_token;
        if (out.task && typeof out.task === 'object') {
          const task = out.task as Record<string, unknown>;
          delete task.claim_token;
        }
      }
      await tx
        .update(workflowMutations)
        .set({
          response: out,
          secretResponse: Object.keys(secrets).length ? encrypt(canonical(secrets), this.deps.keyring) : null,
        })
        .where(eq(workflowMutations.id, receipt.id));
      return { ...out, ...secrets };
    });
    wsPublisher.publish(
      operation === 'state'
        ? 'workflow.state.changed'
        : result.run_id
          ? 'workflow.run.changed'
          : 'workflow.changed',
      {
        operation,
        run_id: result.run_id,
        workflow_id: result.workflow_id,
      },
    );
    if (result._workflow_error) {
      const err = result._workflow_error as { message: string; code: string; extra: Record<string, unknown> };
      throw new ConflictError(err.message, err.code, err.extra);
    }
    return actor.kind === 'agent' && ['run_note', 'task_claim', 'task_update'].includes(operation)
      ? compactRunMutation(result) : result;
  }
  async list(body: unknown = {}) {
    const input = pageSchema
      .extend({ search: z.string().max(255).optional(), status: z.enum(['active', 'archived']).optional() })
      .parse(body);
    const where = and(
      input.status ? eq(workflows.status, input.status) : undefined,
      input.search
        ? or(
            like(workflows.title, `%${input.search}%`),
            like(workflows.summary, `%${input.search}%`),
            like(workflows.slug, `%${input.search}%`),
          )
        : undefined,
    );
    const rows = await this.deps.db
      .select()
      .from(workflows)
      .where(where)
      .orderBy(desc(workflows.updatedAt), asc(workflows.id))
      .limit(input.limit + 1)
      .offset(input.cursor);
    return {
      enabled: await this.isEnabled(),
      items: rows.slice(0, input.limit).map((w) => ({
        workflow_id: w.id,
        slug: w.slug,
        status: w.status,
        version: w.currentVersion,
        control_version: w.controlVersion,
        title: w.title,
        summary: w.summary,
        created_at: w.createdAt,
        updated_at: w.updatedAt,
      })),
      next_cursor: rows.length > input.limit ? input.cursor + input.limit : null,
    };
  }
  async get(id: string, version?: number) {
    const [w] = await this.deps.db
      .select()
      .from(workflows)
      .where(/^[0-9a-f-]{36}$/i.test(id) ? eq(workflows.id, id) : eq(workflows.slug, id));
    if (!w) throw new NotFoundError('Workflow not found', 'workflow_not_found');
    const [v] = await this.deps.db
      .select()
      .from(workflowVersions)
      .where(
        and(eq(workflowVersions.workflowId, w.id), eq(workflowVersions.version, version ?? w.currentVersion)),
      );
    if (!v) throw new NotFoundError('Version not found', 'workflow_version_not_found');
    return {
      enabled: await this.isEnabled(),
      workflow_id: w.id,
      slug: w.slug,
      status: w.status,
      version: v.version,
      current_version: w.currentVersion,
      control_version: w.controlVersion,
      title: (v.document as WorkflowDocument).title,
      summary: (v.document as WorkflowDocument).summary,
      document: v.document,
      sha256: v.sha256,
      reason: v.reason,
      diff: v.diff,
      source_run_id: v.sourceRunId,
      actor: v.actor,
      created_at: v.createdAt,
      updated_at: w.updatedAt,
    };
  }
  async versions(id: string, body: unknown = {}) {
    const w = await this.get(id),
      input = pageSchema.parse(body);
    const rows = await this.deps.db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, w.workflow_id))
      .orderBy(desc(workflowVersions.version))
      .limit(input.limit + 1)
      .offset(input.cursor);
    return {
      items: rows.slice(0, input.limit).map((v) => ({
        version: v.version,
        sha256: v.sha256,
        reason: v.reason,
        document: v.document,
        diff: v.diff,
        source_run_id: v.sourceRunId,
        actor: v.actor,
        created_at: v.createdAt,
      })),
      next_cursor: rows.length > input.limit ? input.cursor + input.limit : null,
    };
  }
  async runList(body: unknown = {}) {
    const input = pageSchema
      .extend({
        workflow_id: z.string().optional(),
        status: z.enum(['pending', 'running', 'paused', 'blocked', 'evaluating', 'completed']).optional(),
        outcome: z.enum(['succeeded', 'partial', 'failed', 'canceled', 'unknown']).optional(),
        agent_address_id: z.string().uuid().optional(),
        evaluation: z.enum(['pending', 'final']).optional(),
        search: z.string().max(255).optional(),
      })
      .parse(body);
    let memberRuns: string[] | undefined;
    if (input.agent_address_id) {
      const rows = await this.deps.db
        .select({ runId: workflowRunMembers.runId })
        .from(workflowRunMembers)
        .where(eq(workflowRunMembers.agentAddressId, input.agent_address_id));
      memberRuns = rows.map((m) => m.runId);
      if (!memberRuns.length) return { enabled: await this.isEnabled(), items: [], next_cursor: null };
    }
    const rows = await this.deps.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          input.workflow_id ? eq(workflowRuns.workflowId, input.workflow_id) : undefined,
          input.status ? eq(workflowRuns.status, input.status) : undefined,
          input.evaluation
            ? eq(workflowRuns.status, input.evaluation === 'pending' ? 'evaluating' : 'completed')
            : undefined,
          input.search ? like(workflowRuns.title, `%${input.search}%`) : undefined,
          input.outcome ? eq(workflowRuns.outcome, input.outcome) : undefined,
          memberRuns ? inArray(workflowRuns.id, memberRuns) : undefined,
        ),
      )
      .orderBy(desc(workflowRuns.createdAt), asc(workflowRuns.id))
      .limit(input.limit + 1)
      .offset(input.cursor);
    return {
      enabled: await this.isEnabled(),
      items: rows.slice(0, input.limit).map((r) => runView(r, this.baseUrl)),
      next_cursor: rows.length > input.limit ? input.cursor + input.limit : null,
    };
  }
  async runGet(runId: string, body: unknown = {}) {
    const options = pageSchema
      .extend({ task_id: z.string().optional(), section: z.enum(['events', 'tasks']).optional() })
      .parse(body);
    if (options.task_id) return this.taskDetail(runId, options.task_id, options);
    if (options.section === 'events') return this.events(runId, options);
    const [run] = await this.deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    if (!run) throw new NotFoundError('Run not found', 'workflow_run_not_found');
    const [ts, ms, invs, evals] = await Promise.all([
      this.deps.db
        .select()
        .from(workflowRunTasks)
        .where(eq(workflowRunTasks.runId, runId))
        .orderBy(asc(workflowRunTasks.position))
        .limit(options.limit + 1)
        .offset(options.cursor),
      this.deps.db.select().from(workflowRunMembers).where(eq(workflowRunMembers.runId, runId)),
      this.deps.db
        .select()
        .from(workflowRunInvitations)
        .where(and(eq(workflowRunInvitations.runId, runId), eq(workflowRunInvitations.status, 'pending')))
        .orderBy(desc(workflowRunInvitations.createdAt))
        .limit(100),
      this.deps.db.select().from(workflowRunEvaluations).where(eq(workflowRunEvaluations.runId, runId)),
    ]);
    const e = evals[0],
      now = new Date().toISOString();
    return {
      enabled: await this.isEnabled(),
      ...runView(run, this.baseUrl),
      server_time: now,
      tasks: ts.slice(0, options.limit).map((t) => taskView(t, now)),
      next_cursor: ts.length > options.limit ? options.cursor + options.limit : null,
      members: ms.map((m) => ({
        address_id: m.agentAddressId,
        session_id: m.sessionId,
        binding_generation: m.bindingGeneration,
        status: m.status,
        ...m.actor,
        joined_at: m.createdAt,
        updated_at: m.updatedAt,
      })),
      invitations: invs.map((i) => invitationView(i, now)),
      evaluation: e
        ? {
            version: e.version,
            status: e.status,
            draft: e.draft,
            applied_version: e.appliedVersion,
            finalized_at: e.finalizedAt,
          }
        : null,
    };
  }
  async events(runId: string, body: unknown = {}) {
    const input = pageSchema.parse(body);
    const rows = await this.deps.db
      .select()
      .from(workflowRunEvents)
      .where(and(eq(workflowRunEvents.runId, runId), gt(workflowRunEvents.sequence, input.cursor)))
      .orderBy(asc(workflowRunEvents.sequence))
      .limit(input.limit + 1);
    return {
      items: rows.slice(0, input.limit).map((e) => ({
        id: e.id,
        sequence: e.sequence,
        type: e.type,
        actor: e.actor,
        detail: e.detail,
        created_at: e.createdAt,
      })),
      next_cursor: rows.length > input.limit ? rows[input.limit - 1]!.sequence : null,
    };
  }
  async taskDetail(runId: string, taskId: string, body: unknown = {}) {
    const input = pageSchema.parse(body);
    const [t] = await this.deps.db
      .select()
      .from(workflowRunTasks)
      .where(and(eq(workflowRunTasks.runId, runId), eq(workflowRunTasks.taskId, taskId)));
    if (!t) throw new NotFoundError('Task not found', 'workflow_task_not_found');
    const attempts = await this.deps.db
      .select()
      .from(workflowTaskAttempts)
      .where(and(eq(workflowTaskAttempts.runId, runId), eq(workflowTaskAttempts.taskId, taskId)))
      .orderBy(asc(workflowTaskAttempts.attemptNo))
      .limit(input.limit + 1)
      .offset(input.cursor);
    const now = new Date().toISOString();
    const [run] = await this.deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    if (!run) throw new NotFoundError('Run not found', 'workflow_run_not_found');
    const [version] = await this.deps.db.select().from(workflowVersions).where(eq(workflowVersions.id, run.workflowVersionId));
    const address = t.claimOwnerAddressId ?? run.coordinatorAddressId;
    const [subject] = address ? await this.deps.db.select().from(workflowRunMembers).where(and(
      eq(workflowRunMembers.runId, runId), eq(workflowRunMembers.agentAddressId, address), eq(workflowRunMembers.status, 'active'),
    )) : [];
    const knowledge = version && subject ? {
      subject: { ...subject.actor, address_id: subject.agentAddressId, session_id: subject.sessionId, binding_generation: subject.bindingGeneration },
      role: t.claimOwnerAddressId ? 'claim_owner' : 'coordinator',
      checks: await this.deps.db.transaction((tx) => knowledgeChecks({ tx, now, actor: {
        ...subject.actor, kind: 'agent', id: subject.agentAddressId,
        address_id: subject.agentAddressId, session_id: subject.sessionId, binding_generation: subject.bindingGeneration,
      } }, run, version.document as WorkflowDocument, taskId)),
    } : version ? {
      subject: null, role: null,
      checks: requiredKnowledge(version.document as WorkflowDocument, taskId).map((knowledge) => ({
        knowledge_id: knowledge.id, title: knowledge.title, uri: knowledgeUri(run, knowledge),
        applicability: knowledge.required_check!.applicability, blocker: 'missing_receipt', receipt: null,
      })),
    } : null;
    return {
      server_time: now,
      task: { ...taskView(t, now), outputs: t.outputs, evidence: t.evidence },
      knowledge,
      attempts: attempts.slice(0, input.limit).map((a) => ({
        id: a.id,
        attempt_no: a.attemptNo,
        status: a.status,
        actor: a.actor,
        execution_host: a.executionHost,
        summary: a.summary,
        outputs: a.outputs,
        evidence: a.evidence,
        error: a.error,
        started_at: a.startedAt,
        ended_at: a.endedAt,
      })),
      next_cursor: attempts.length > input.limit ? input.cursor + input.limit : null,
    };
  }
  async report(runId: string) {
    const snapshot = await this.runGet(runId);
    const [run] = await this.deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    if (!run) throw new NotFoundError('Run not found');
    const [v] = await this.deps.db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, run.workflowVersionId));
    return { ...snapshot, document: v?.document, report: run.report };
  }
  async runCurrent(actor: WorkflowActor) {
    const now = await this.deps.db.transaction(async (tx) => {
      if (this.deps.collaboration) await this.deps.collaboration.lock(tx, actor);
      await this.authenticate(tx, actor);
      return dbNow(tx);
    });
    requireAgent(actor);
    const memberRows = await this.deps.db
      .select()
      .from(workflowRunMembers)
      .where(
        and(
          eq(workflowRunMembers.agentAddressId, actor.address_id!),
          eq(workflowRunMembers.status, 'active'),
        ),
      );
    const openRuns = memberRows.length
      ? await this.deps.db
          .select()
          .from(workflowRuns)
          .where(
            and(
              inArray(
                workflowRuns.id,
                memberRows.map((m) => m.runId),
              ),
              sql`${workflowRuns.status} <> 'completed'`,
            ),
          )
      : [];
    const invitations = await this.deps.db
      .select()
      .from(workflowRunInvitations)
      .where(
        and(
          eq(workflowRunInvitations.targetAddressId, actor.address_id!),
          eq(workflowRunInvitations.targetSessionId, actor.session_id!),
          eq(workflowRunInvitations.targetBindingGeneration, actor.binding_generation!),
          eq(workflowRunInvitations.status, 'pending'),
        ),
      );
    const claims = await this.deps.db
      .select()
      .from(workflowRunTasks)
      .where(eq(workflowRunTasks.claimOwnerAddressId, actor.address_id!));
    const currentRunIds = new Set(
      memberRows
        .filter((m) => m.sessionId === actor.session_id && m.bindingGeneration === actor.binding_generation)
        .map((m) => m.runId),
    );
    const runs = openRuns.filter((r) => currentRunIds.has(r.id));
    const currentClaim = (t: (typeof claims)[number]) =>
      t.claimSessionId === actor.session_id && t.claimBindingGeneration === actor.binding_generation;
    return {
      server_time: now,
      // Historical bindings are discovery only: no membership or claim is transferred.
      stale_memberships: openRuns
        .filter((r) => !currentRunIds.has(r.id))
        .map((r) => {
          const membership = memberRows.find((m) => m.runId === r.id)!;
          return {
            ...runView(r, this.baseUrl),
            binding_current: false as const,
            session_id: membership.sessionId,
            binding_generation: membership.bindingGeneration,
            recovery_required: 'operator_coordinator_recover' as const,
          };
        }),
      stale_claims: claims
        .filter((t) => !currentClaim(t))
        .map((t) => ({
          run_id: t.runId,
          ...taskView(t, now),
          binding_current: false as const,
          session_id: t.claimSessionId,
          binding_generation: t.claimBindingGeneration,
          recovery_required: 'resolve_old_claim_then_operator_recovery' as const,
        })),
      enabled: await this.isEnabled(),
      runs: runs.map((r) => runView(r, this.baseUrl)),
      invitations: invitations.map((i) => invitationView(i)),
      claims: claims.filter(currentClaim).map((t) => ({ run_id: t.runId, ...taskView(t, now) })),
      pending_evaluations: runs.filter((r) => r.status === 'evaluating').map((r) => runView(r, this.baseUrl)),
    };
  }
}

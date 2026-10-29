import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Capability } from '../../security/capabilities.js';
import type { ChatMetadata } from '../../services/agent-chat/contracts.js';
import { feedbackSubmitSchema, type FeedbackActor } from '../../services/feedback-contract.js';
import { ApiError, NotFoundError } from '../../http/errors.js';
import {
  DAEMON_PERMISSION_MODES,
  PLAN_APPROVED_PROMPT,
  type DaemonPermissionMode,
} from '../../services/host-daemon/permission-mode.js';
import type { PortalDaemonInput } from '../../services/host-daemon/service.js';

/**
 * R4 mobile tools: additive, device-bearer routes over existing services. Every
 * route re-checks the operator's capability through the device credential, and
 * every write reuses the service the admin console already calls.
 */
export interface CompanionToolsDeps {
  authorize(
    req: FastifyRequest,
    capability: Capability,
  ): Promise<{ user: { id: number; name: string }; device: { id: string } }>;
  daemon: {
    stop(id: string, owner: string, expected: undefined, actor: string): Promise<{ id: string; status: string; permissionMode?: string | null }>;
    setPermissionMode(
      id: string,
      mode: DaemonPermissionMode,
      owner: string,
      actor: string,
    ): Promise<{ session_id: string; permission_mode: DaemonPermissionMode; changed: boolean }>;
    turn(
      id: string,
      prompt: string,
      clientId: string,
      owner: string,
      portalInput: PortalDaemonInput,
    ): Promise<{ operation_id: string; session_id: string }>;
  };
  /** The daemon session if it belongs to this operator; null when unknown. */
  ownSession(id: string, userId: number): Promise<{ id: string; status: string } | null>;
  workflowRuns(query: { limit: number; cursor: number; status?: string }): Promise<{
    enabled: boolean;
    items: Array<Record<string, unknown>>;
    next_cursor: number | null;
  }>;
  schedules: {
    list(): Promise<{ schedules: Array<Record<string, unknown>> }>;
    lastRuns(ids: string[]): Promise<Map<string, Record<string, unknown>>>;
    get(id: string): Promise<{ schedule: Record<string, unknown> }>;
    update(raw: Record<string, unknown>, actor: string): Promise<{ schedule: Record<string, unknown> }>;
  };
  gitDirector: {
    state(): Promise<{ enabled: boolean }>;
    clones(): Promise<Array<Record<string, unknown>>>;
  };
  projects: {
    list(): Promise<{ projects: Array<Record<string, unknown>> }>;
    boardState(): Promise<{ enabled: boolean }>;
    board(slug: string): Promise<Record<string, unknown>>;
  };
  feedback: { submit(input: unknown, actor: FeedbackActor): Promise<Record<string, unknown>> };
  changed(): void;
}

const uuidParam = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;

/** Strip a schedule view to what a phone shows; the prompt body never leaves. */
export function scheduleCard(schedule: Record<string, unknown>, last?: Record<string, unknown>) {
  return {
    id: schedule.id,
    name: schedule.name,
    target: schedule.target,
    kind: schedule.kind,
    at: schedule.at ?? null,
    cron: schedule.cron ?? null,
    interval_minutes: schedule.interval_minutes ?? null,
    timezone: schedule.timezone ?? null,
    enabled: schedule.enabled === true,
    paused: schedule.enabled !== true,
    pause_reason: schedule.pause_reason ?? null,
    persistent: schedule.persistent === true,
    next_run_at: schedule.enabled === true ? (schedule.next_due_at ?? null) : null,
    version: schedule.version,
    last_run: last ?? null,
    last_error: (last?.last_error as string | null | undefined) ?? null,
    updated_at: schedule.updated_at ?? null,
  };
}

/** Waiting/allowed merge requests across clones, oldest first. */
export function pendingMerges(clones: Array<Record<string, unknown>>, now = Date.now()) {
  const merges: Array<Record<string, unknown>> = [];
  for (const clone of clones) {
    const worktrees = new Map(
      ((clone.worktrees as Array<Record<string, unknown>> | undefined) ?? []).map((w) => [w.worktree_id, w]),
    );
    for (const lease of (clone.leases as Array<Record<string, unknown>> | undefined) ?? []) {
      if (lease.verdict !== 'wait' && lease.verdict !== 'allow') continue;
      const worktree = worktrees.get(lease.worktree_id);
      const requested = Date.parse(String(lease.requested_at ?? ''));
      merges.push({
        request_id: lease.request_id,
        verdict: lease.verdict,
        status: lease.verdict === 'allow' ? 'allowed' : 'waiting',
        decided_by: lease.decided_by ?? null,
        reason: lease.reason ?? null,
        repo: clone.remote_url ?? clone.repo_root ?? null,
        repo_root: clone.repo_root ?? null,
        host: clone.fqdn ?? null,
        target_branch: lease.target_branch,
        branch: worktree?.branch ?? null,
        agent: worktree
          ? { engine: worktree.engine ?? null, username: worktree.username ?? null, task: worktree.task ?? null }
          : null,
        requested_at: lease.requested_at,
        age_seconds: Number.isFinite(requested) ? Math.max(0, Math.floor((now - requested) / 1000)) : null,
        lease_expires_at: lease.lease_expires_at ?? null,
      });
    }
  }
  return merges.sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)));
}

/** Board columns with card titles, status and assignee; card details stay on the console. */
export function boardView(board: Record<string, unknown>) {
  return {
    project: board.project ?? null,
    columns: ((board.columns as Array<Record<string, unknown>> | undefined) ?? []).map((column) => ({
      id: column.id,
      key: column.key ?? null,
      title: column.title,
      card_count: column.card_count ?? 0,
      wip_limit: column.wip_limit ?? null,
      over_wip: column.over_wip === true,
      truncated: column.truncated === true,
      cards: ((column.cards as Array<Record<string, unknown>> | undefined) ?? []).map((card) => {
        const claim = card.claim as Record<string, unknown> | null | undefined;
        return {
          id: card.id,
          number: card.number,
          title: card.title,
          labels: card.labels ?? [],
          priority: card.priority ?? null,
          due_at: card.due_at ?? null,
          status: card.blocked_reason ? 'blocked' : claim?.held ? 'claimed' : card.ready === false ? 'waiting' : 'open',
          blocked_reason: card.blocked_reason ?? null,
          assignee: claim?.held
            ? { username: claim.username ?? null, host: claim.host ?? null, role: claim.role ?? null }
            : null,
          updated_at: card.updated_at ?? null,
        };
      }),
    })),
  };
}

export function registerCompanionTools(app: FastifyInstance, deps: CompanionToolsDeps) {
  // 1. Stop a daemon session this operator started. Idempotent: an ended
  // session answers its current status.
  app.post('/companion/v1/daemon-sessions/:id/stop', async (req) => {
    const { user } = await deps.authorize(req, 'agent_messaging.manage');
    const id = uuidParam(req);
    if (!(await deps.ownSession(id, user.id))) throw new NotFoundError('Remote session not found');
    const owner = `admin:${user.id}`;
    const result = await deps.daemon.stop(id, owner, undefined, owner);
    deps.changed();
    return { session_id: result.id, status: result.status };
  });

  // C7 part B: switch the native permission mode for the next turn. With
  // client_message_id (mode default), it also resumes the session with the
  // execution instruction: "Approve plan & execute" in one idempotent call.
  app.post('/companion/v1/daemon-sessions/:id/permission-mode', async (req, reply) => {
    const { user, device } = await deps.authorize(req, 'agent_messaging.manage');
    await deps.authorize(req, 'agent_portal.manage');
    const id = uuidParam(req);
    const body = z
      .object({
        mode: z.enum(DAEMON_PERMISSION_MODES),
        client_message_id: z.string().uuid().optional(),
        prompt_id: z.string().uuid().optional(),
        version: z.number().int().positive().optional(),
      })
      .strict()
      .superRefine((value, issue) => {
        if (value.mode !== 'default' && value.client_message_id)
          issue.addIssue({ code: 'custom', path: ['client_message_id'], message: 'Only approval (mode default) resumes the session' });
        if (value.prompt_id && !value.client_message_id)
          issue.addIssue({ code: 'custom', path: ['prompt_id'], message: 'prompt_id requires client_message_id' });
      })
      .parse(req.body ?? {});
    if (body.client_message_id) await deps.authorize(req, 'agent_portal.reveal_transcript');
    if (!(await deps.ownSession(id, user.id))) throw new NotFoundError('Remote session not found');
    const owner = `admin:${user.id}`;
    const mode = await deps.daemon.setPermissionMode(id, body.mode, owner, owner);
    let operation: { operation_id: string } | null = null;
    if (body.client_message_id) {
      const metadata: ChatMetadata | undefined = body.prompt_id ? { choice_value: 'approve' } : undefined;
      operation = await deps.daemon.turn(
        id,
        PLAN_APPROVED_PROMPT + (body.prompt_id ? '\n\nThis answers your open Portal question with Approve.' : ''),
        body.client_message_id,
        owner,
        {
          deviceId: device.id,
          content: body.prompt_id ? 'approve' : 'Approve plan & execute',
          author: user.name,
          ...(metadata ? { metadata } : {}),
          ...(body.prompt_id ? { promptId: body.prompt_id } : {}),
          ...(body.version !== undefined ? { version: body.version } : {}),
        },
      );
      reply.code(202);
    }
    deps.changed();
    return { ...mode, operation_id: operation?.operation_id ?? null };
  });

  // 2. Workflow runs. Evaluations are agent-only (agent_workflow_run_evaluate);
  // no admin route answers a decision, so `awaiting_decision` is informational.
  app.get('/companion/v1/workflow-runs', async (req) => {
    await deps.authorize(req, 'workflows.read');
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.coerce.number().int().nonnegative().default(0),
        status: z.enum(['pending', 'running', 'paused', 'blocked', 'evaluating', 'completed']).optional(),
      })
      .strict()
      .parse(req.query ?? {});
    const result = await deps.workflowRuns(query);
    return {
      enabled: result.enabled,
      runs: result.items.map((run) => ({
        run_id: run.run_id,
        workflow_id: run.workflow_id,
        workflow_version: run.workflow_version,
        title: run.title,
        status: run.status,
        outcome: run.outcome ?? null,
        summary: run.summary ?? null,
        report_url: run.report_url,
        open_items: run.open_items ?? null,
        cancel_requested: run.cancel_requested === true,
        awaiting_decision: run.status === 'evaluating' ? 'evaluation' : run.status === 'blocked' ? 'blocked' : null,
        created_at: run.created_at,
        updated_at: run.updated_at,
        started_at: run.started_at ?? null,
        finished_at: run.finished_at ?? null,
      })),
      next_cursor: result.next_cursor,
    };
  });

  // 3. Schedules: list, pause, resume.
  app.get('/companion/v1/schedules', async (req) => {
    await deps.authorize(req, 'agent_messaging.read');
    const { schedules } = await deps.schedules.list();
    const last = await deps.schedules.lastRuns(schedules.map((s) => String(s.id)));
    return { schedules: schedules.map((s) => scheduleCard(s, last.get(String(s.id)))) };
  });
  const toggle = (enabled: boolean) => async (req: FastifyRequest) => {
    const { user } = await deps.authorize(req, 'agent_messaging.manage');
    const id = uuidParam(req);
    const body = z.object({ version: z.number().int().positive() }).strict().parse(req.body ?? {});
    const current = (await deps.schedules.get(id)).schedule;
    // Already in the requested state: a retried pause/resume is a no-op.
    if ((current.enabled === true) === enabled) {
      const last = await deps.schedules.lastRuns([id]);
      return { schedule: scheduleCard(current, last.get(id)), changed: false };
    }
    const updated = (await deps.schedules.update({ id, version: body.version, enabled }, `admin:${user.id}`)).schedule;
    const last = await deps.schedules.lastRuns([id]);
    deps.changed();
    return { schedule: scheduleCard(updated, last.get(id)), changed: true };
  };
  app.post('/companion/v1/schedules/:id/pause', toggle(false));
  app.post('/companion/v1/schedules/:id/resume', toggle(true));

  // 5. Git Director pending merges, read-only.
  app.get('/companion/v1/git-director/merges', async (req) => {
    await deps.authorize(req, 'git_director.read');
    const state = await deps.gitDirector.state();
    if (!state.enabled) return { enabled: false, merges: [] };
    return { enabled: true, merges: pendingMerges(await deps.gitDirector.clones()) };
  });

  // 6. Project board, read-only.
  app.get('/companion/v1/projects', async (req) => {
    await deps.authorize(req, 'projects.read');
    const [{ projects }, board] = await Promise.all([deps.projects.list(), deps.projects.boardState()]);
    return {
      board_enabled: board.enabled,
      projects: projects
        .filter((p) => !p.archived_at)
        .map((p) => ({ slug: p.slug, title: p.title, description: p.description ?? '', updated_at: p.updated_at })),
    };
  });
  app.get('/companion/v1/projects/:slug/board', async (req) => {
    await deps.authorize(req, 'projects.read');
    const slug = z
      .object({ slug: z.string().trim().min(1).max(128) })
      .parse(req.params).slug;
    if (!(await deps.projects.boardState()).enabled)
      throw new ApiError('The project board is disabled', { status: 409, code: 'project_board_disabled' });
    return boardView(await deps.projects.board(slug));
  });

  // 7. Feedback submit (text only: feedback has no attachment mechanism).
  app.post('/companion/v1/feedback', async (req, reply) => {
    const { user, device } = await deps.authorize(req, 'feedback.manage');
    const body = feedbackSubmitSchema
      .pick({ client_request_id: true, type: true, title: true, description: true, component: true, priority: true })
      .strict()
      .parse(req.body ?? {});
    const result = await deps.feedback.submit(body, {
      host_id: null,
      engine: null,
      admin_user_id: user.id,
      surface: 'companion',
      device_id: device.id,
    });
    reply.code(result.replayed ? 200 : 201);
    const feedback = (result.feedback ?? {}) as Record<string, unknown>;
    return {
      feedback: { id: feedback.id, status: feedback.status, title: feedback.title, component: feedback.component, created_at: feedback.created_at },
      replayed: result.replayed === true,
    };
  });
}

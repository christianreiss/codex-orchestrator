import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { ForbiddenError, UnauthorizedError } from '../../../src/http/errors.js';
import type { Capability } from '../../../src/security/capabilities.js';
import { roleHasCapability } from '../../../src/security/capabilities.js';
import {
  boardView,
  pendingMerges,
  registerCompanionTools,
  scheduleCard,
  type CompanionToolsDeps,
} from '../../../src/routes/companion/tools.js';
import { PLAN_APPROVED_PROMPT } from '../../../src/services/host-daemon/permission-mode.js';

const auth = { authorization: `Bearer ${'a'.repeat(64)}` };
const sessionId = randomUUID();
const scheduleId = randomUUID();

function deps(role = 'owner', overrides: Partial<CompanionToolsDeps> = {}) {
  const seen: Capability[] = [];
  const base = {
    authorize: vi.fn(async (req: { headers: { authorization?: string } }, capability: Capability) => {
      if (!req.headers.authorization) throw new UnauthorizedError('Device credential required', 'device_required');
      seen.push(capability);
      if (!roleHasCapability(role, capability)) throw new ForbiddenError('Capability required', 'capability_required');
      return { user: { id: 7, name: 'Chris' }, device: { id: 'device-1' } };
    }),
    daemon: {
      stop: vi.fn(async (id: string) => ({ id, status: 'closed' })),
      setPermissionMode: vi.fn(async (id: string, mode: 'plan' | 'default') => ({ session_id: id, permission_mode: mode, changed: true })),
      turn: vi.fn(async (id: string) => ({ operation_id: 'op-1', session_id: id })),
    },
    ownSession: vi.fn(async (id: string) => (id === sessionId ? { id, status: 'waiting' } : null)),
    workflowRuns: vi.fn(async () => ({
      enabled: true,
      items: [
        { run_id: 'r1', workflow_id: 'w', workflow_version: 2, title: 'Release', status: 'evaluating', outcome: 'succeeded', summary: 'Done', report_url: 'https://fleet/admin/workflows/runs/r1', inputs: { secret: 'x' }, created_at: 'a', updated_at: 'b' },
        { run_id: 'r2', workflow_id: 'w', workflow_version: 2, title: 'Next', status: 'running', outcome: null, summary: null, report_url: 'u', created_at: 'a', updated_at: 'b' },
      ],
      next_cursor: null,
    })),
    schedules: {
      list: vi.fn(async () => ({ schedules: [{ id: scheduleId, name: 'nightly', target: 'agent:x', kind: 'cron', cron: '0 3 * * *', enabled: true, next_due_at: '2026-10-30T03:00:00Z', version: 3, prompt: 'never' }] })),
      lastRuns: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { status: 'blocked', due_at: 'd', last_error: 'quota_wait', updated_at: 'u' }]))),
      get: vi.fn(async () => ({ schedule: { id: scheduleId, name: 'nightly', enabled: true, version: 3, prompt: 'never' } })),
      update: vi.fn(async (raw: Record<string, unknown>) => ({ schedule: { id: scheduleId, name: 'nightly', enabled: raw.enabled, version: 4, prompt: 'never' } })),
    },
    gitDirector: {
      state: vi.fn(async () => ({ enabled: true })),
      clones: vi.fn(async () => [
        {
          remote_url: 'git@example:repo.git', repo_root: '/src/repo', fqdn: 'host-a',
          worktrees: [{ worktree_id: 'wt', branch: 'task/x', engine: 'claude', username: 'chris', task: 'fix' }],
          leases: [
            { request_id: 'm2', worktree_id: 'wt', target_branch: 'main', verdict: 'allow', requested_at: '2026-10-29T10:00:00Z' },
            { request_id: 'm1', worktree_id: 'gone', target_branch: 'main', verdict: 'wait', requested_at: '2026-10-29T09:00:00Z' },
          ],
        },
      ]),
    },
    projects: {
      list: vi.fn(async () => ({ projects: [{ slug: 'app', title: 'App', description: 'd', updated_at: 'u' }, { slug: 'old', title: 'Old', archived_at: 'x' }] })),
      boardState: vi.fn(async () => ({ enabled: true })),
      board: vi.fn(async () => ({
        project: 'app',
        columns: [{ id: 'c', key: 'todo', title: 'To do', card_count: 2, cards: [
          { id: 'k1', number: 1, title: 'One', detail: 'private detail', claim: { held: true, username: 'chris', host: 'h', role: 'dev' }, ready: true },
          { id: 'k2', number: 2, title: 'Two', detail: 'x', claim: null, ready: false },
        ] }],
      })),
    },
    feedback: { submit: vi.fn(async () => ({ feedback: { id: 'f1', status: 'open', title: 'Bug', component: 'android', created_at: 't', report: { description: 'secret' } }, replayed: false })) },
    changed: vi.fn(),
  };
  // Overrides replace whole dependencies; the mocks keep their mock typing.
  const d = Object.assign(base, overrides) as typeof base;
  return { d, seen };
}
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
async function build(d: ReturnType<typeof deps>['d']) {
  app = Fastify();
  await app.register(envelopePlugin);
  registerCompanionTools(app, d as unknown as CompanionToolsDeps);
  await app.ready();
  return app;
}

describe('companion R4 tool routes: authentication and capability', () => {
  it.each([
    ['POST', `/companion/v1/daemon-sessions/${sessionId}/stop`, {}],
    ['POST', `/companion/v1/daemon-sessions/${sessionId}/permission-mode`, { mode: 'default' }],
    ['GET', '/companion/v1/workflow-runs', undefined],
    ['GET', '/companion/v1/schedules', undefined],
    ['POST', `/companion/v1/schedules/${scheduleId}/pause`, { version: 3 }],
    ['GET', '/companion/v1/git-director/merges', undefined],
    ['GET', '/companion/v1/projects', undefined],
    ['GET', '/companion/v1/projects/app/board', undefined],
    ['POST', '/companion/v1/feedback', { client_request_id: randomUUID(), type: 'bug', title: 't', description: 'd' }],
  ] as const)('%s %s needs a device credential', async (method, url, payload) => {
    const { d } = deps();
    const res = await (await build(d)).inject({ method, url, ...(payload ? { payload } : {}) });
    expect(res.statusCode).toBe(401);
  });
  it('maps each route to the existing admin capability', async () => {
    const { d, seen } = deps();
    const a = await build(d);
    const call = (method: 'GET' | 'POST', url: string, payload?: object) => a.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
    await call('POST', `/companion/v1/daemon-sessions/${sessionId}/stop`, {});
    expect(seen.splice(0)).toEqual(['agent_messaging.manage']);
    await call('POST', `/companion/v1/daemon-sessions/${sessionId}/permission-mode`, { mode: 'default', client_message_id: randomUUID() });
    expect(seen.splice(0)).toEqual(['agent_messaging.manage', 'agent_portal.manage', 'agent_portal.reveal_transcript']);
    await call('GET', '/companion/v1/workflow-runs');
    expect(seen.splice(0)).toEqual(['workflows.read']);
    await call('GET', '/companion/v1/schedules');
    expect(seen.splice(0)).toEqual(['agent_messaging.read']);
    await call('POST', `/companion/v1/schedules/${scheduleId}/resume`, { version: 3 });
    expect(seen.splice(0)).toEqual(['agent_messaging.manage']);
    await call('GET', '/companion/v1/git-director/merges');
    expect(seen.splice(0)).toEqual(['git_director.read']);
    await call('GET', '/companion/v1/projects');
    await call('GET', '/companion/v1/projects/app/board');
    expect(seen.splice(0)).toEqual(['projects.read', 'projects.read']);
    await call('POST', '/companion/v1/feedback', { client_request_id: randomUUID(), type: 'bug', title: 't', description: 'd' });
    expect(seen.splice(0)).toEqual(['feedback.manage']);
  });
  it('lets a viewer read but not stop, switch, pause or submit, without touching a service', async () => {
    const { d } = deps('viewer');
    const a = await build(d);
    for (const [url, payload] of [
      [`/companion/v1/daemon-sessions/${sessionId}/stop`, {}],
      [`/companion/v1/daemon-sessions/${sessionId}/permission-mode`, { mode: 'default' }],
      [`/companion/v1/schedules/${scheduleId}/pause`, { version: 3 }],
      ['/companion/v1/feedback', { client_request_id: randomUUID(), type: 'bug', title: 't', description: 'd' }],
    ] as const)
      expect((await a.inject({ method: 'POST', url, headers: auth, payload })).statusCode).toBe(403);
    expect(d.daemon.stop).not.toHaveBeenCalled();
    expect(d.daemon.setPermissionMode).not.toHaveBeenCalled();
    expect(d.schedules.update).not.toHaveBeenCalled();
    expect(d.feedback.submit).not.toHaveBeenCalled();
    expect((await a.inject({ url: '/companion/v1/schedules', headers: auth })).statusCode).toBe(200);
    expect((await a.inject({ url: '/companion/v1/workflow-runs', headers: auth })).statusCode).toBe(200);
  });
});

describe('remote session stop and plan approval', () => {
  it('stops only an own session and reports its status', async () => {
    const { d } = deps();
    const a = await build(d);
    const res = await a.inject({ method: 'POST', url: `/companion/v1/daemon-sessions/${sessionId}/stop`, headers: auth, payload: {} });
    expect(res.json()).toMatchObject({ session_id: sessionId, status: 'closed' });
    expect(d.daemon.stop).toHaveBeenCalledWith(sessionId, 'admin:7', undefined, 'admin:7');
    expect((await a.inject({ method: 'POST', url: `/companion/v1/daemon-sessions/${randomUUID()}/stop`, headers: auth, payload: {} })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/companion/v1/daemon-sessions/not-a-uuid/stop', headers: auth, payload: {} })).statusCode).toBe(422);
  });
  it('switches mode without resuming when no client_message_id is given', async () => {
    const { d } = deps();
    const res = await (await build(d)).inject({ method: 'POST', url: `/companion/v1/daemon-sessions/${sessionId}/permission-mode`, headers: auth, payload: { mode: 'plan' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ session_id: sessionId, permission_mode: 'plan', operation_id: null });
    expect(d.daemon.turn).not.toHaveBeenCalled();
  });
  it('approves the plan and resumes with the execution instruction, answering the open question', async () => {
    const { d } = deps();
    const key = randomUUID(), prompt = randomUUID();
    const res = await (await build(d)).inject({
      method: 'POST', url: `/companion/v1/daemon-sessions/${sessionId}/permission-mode`, headers: auth,
      payload: { mode: 'default', client_message_id: key, prompt_id: prompt, version: 2 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ permission_mode: 'default', operation_id: 'op-1' });
    expect(d.daemon.setPermissionMode).toHaveBeenCalledWith(sessionId, 'default', 'admin:7', 'admin:7');
    expect(d.daemon.setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(d.daemon.turn.mock.invocationCallOrder[0]!);
    expect(d.daemon.turn).toHaveBeenCalledWith(
      sessionId,
      expect.stringContaining(PLAN_APPROVED_PROMPT),
      key,
      'admin:7',
      expect.objectContaining({ deviceId: 'device-1', content: 'approve', promptId: prompt, version: 2, metadata: { choice_value: 'approve' } }),
    );
  });
  it('rejects resuming into plan mode, a prompt without a key, unknown fields and modes', async () => {
    const { d } = deps();
    const a = await build(d);
    for (const payload of [
      { mode: 'plan', client_message_id: randomUUID() },
      { mode: 'default', prompt_id: randomUUID() },
      { mode: 'bypassPermissions' },
      { mode: 'default', extra: 1 },
    ])
      expect((await a.inject({ method: 'POST', url: `/companion/v1/daemon-sessions/${sessionId}/permission-mode`, headers: auth, payload })).statusCode).toBe(422);
    expect(d.daemon.setPermissionMode).not.toHaveBeenCalled();
  });
  it('passes service conflicts through (an old wrapper is 409 permission_mode_unsupported)', async () => {
    const { d } = deps();
    const { ConflictError } = await import('../../../src/http/errors.js');
    d.daemon.setPermissionMode.mockRejectedValueOnce(new ConflictError('old wrapper', 'permission_mode_unsupported'));
    const res = await (await build(d)).inject({ method: 'POST', url: `/companion/v1/daemon-sessions/${sessionId}/permission-mode`, headers: auth, payload: { mode: 'plan' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'permission_mode_unsupported' });
  });
});

describe('read-only projections', () => {
  it('lists workflow runs with report URL, summary and decision state, without inputs', async () => {
    const { d } = deps();
    const res = await (await build(d)).inject({ url: '/companion/v1/workflow-runs?limit=10&status=evaluating', headers: auth });
    expect(d.workflowRuns).toHaveBeenCalledWith({ limit: 10, cursor: 0, status: 'evaluating' });
    const body = res.json();
    expect(body.runs[0]).toMatchObject({ run_id: 'r1', summary: 'Done', report_url: expect.stringContaining('/r1'), awaiting_decision: 'evaluation' });
    expect(body.runs[1].awaiting_decision).toBeNull();
    expect(JSON.stringify(body)).not.toContain('secret');
  });
  it('projects schedules without prompts and with the latest run error', () => {
    const card = scheduleCard({ id: 's', enabled: false, next_due_at: 'n', pause_reason: 'agent_gone', version: 2, prompt: 'p' }, { last_error: 'quota_wait' });
    expect(card).toMatchObject({ paused: true, enabled: false, next_run_at: null, pause_reason: 'agent_gone', last_error: 'quota_wait', version: 2 });
    expect(card).not.toHaveProperty('prompt');
  });
  it('flattens waiting and allowed merges oldest first with branch, agent and age', () => {
    const merges = pendingMerges(
      [{ remote_url: 'r', fqdn: 'h', worktrees: [{ worktree_id: 'w', branch: 'b', engine: 'codex', username: 'u', task: 't' }],
        leases: [
          { request_id: 'new', worktree_id: 'w', target_branch: 'main', verdict: 'allow', requested_at: '2026-10-29T10:00:00Z' },
          { request_id: 'old', worktree_id: 'x', target_branch: 'main', verdict: 'wait', requested_at: '2026-10-29T09:00:00Z' },
          { request_id: 'denied', worktree_id: 'w', target_branch: 'main', verdict: 'deny', requested_at: '2026-10-29T08:00:00Z' },
        ] }],
      Date.parse('2026-10-29T10:01:00Z'),
    );
    expect(merges.map((m) => [m.request_id, m.status, m.age_seconds])).toEqual([['old', 'waiting', 3660], ['new', 'allowed', 60]]);
    expect(merges[1]).toMatchObject({ repo: 'r', branch: 'b', target_branch: 'main', agent: { engine: 'codex', username: 'u', task: 't' } });
    expect(merges[0]!.agent).toBeNull();
  });
  it('reports a disabled Git Director without reading clones', async () => {
    const { d } = deps();
    d.gitDirector.state.mockResolvedValueOnce({ enabled: false });
    const body = (await (await build(d)).inject({ url: '/companion/v1/git-director/merges', headers: auth })).json();
    expect(body).toMatchObject({ enabled: false, merges: [] });
    expect(d.gitDirector.clones).not.toHaveBeenCalled();
  });
  it('lists active projects and a board with status and assignee but no card detail', async () => {
    const { d } = deps();
    const a = await build(d);
    expect((await a.inject({ url: '/companion/v1/projects', headers: auth })).json()).toMatchObject({ board_enabled: true, projects: [{ slug: 'app', title: 'App' }] });
    const board = (await a.inject({ url: '/companion/v1/projects/app/board', headers: auth })).json();
    expect(board.columns[0].cards.map((c: { status: string }) => c.status)).toEqual(['claimed', 'waiting']);
    expect(board.columns[0].cards[0].assignee).toEqual({ username: 'chris', host: 'h', role: 'dev' });
    expect(JSON.stringify(board)).not.toContain('private detail');
    expect(boardView({ columns: [] })).toEqual({ project: null, columns: [] });
    d.projects.boardState.mockResolvedValueOnce({ enabled: false });
    expect((await a.inject({ url: '/companion/v1/projects/app/board', headers: auth })).statusCode).toBe(409);
  });
});

describe('schedule pause/resume and feedback writes', () => {
  it('pauses with the caller version and treats a repeated pause as a no-op', async () => {
    const { d } = deps();
    const a = await build(d);
    const res = await a.inject({ method: 'POST', url: `/companion/v1/schedules/${scheduleId}/pause`, headers: auth, payload: { version: 3 } });
    expect(res.json()).toMatchObject({ changed: true, schedule: { paused: true, version: 4 } });
    expect(d.schedules.update).toHaveBeenCalledWith({ id: scheduleId, version: 3, enabled: false }, 'admin:7');
    expect(JSON.stringify(res.json())).not.toContain('never');
    d.schedules.get.mockResolvedValueOnce({ schedule: { id: scheduleId, name: 'nightly', enabled: false, version: 4, prompt: 'never' } });
    const again = await a.inject({ method: 'POST', url: `/companion/v1/schedules/${scheduleId}/pause`, headers: auth, payload: { version: 3 } });
    expect(again.json()).toMatchObject({ changed: false, schedule: { paused: true } });
    expect(d.schedules.update).toHaveBeenCalledTimes(1);
    expect((await a.inject({ method: 'POST', url: `/companion/v1/schedules/${scheduleId}/resume`, headers: auth, payload: {} })).statusCode).toBe(422);
  });
  it('submits text feedback through the feedback service as the operator, idempotently by client_request_id', async () => {
    const { d } = deps();
    const a = await build(d);
    const payload = { client_request_id: randomUUID(), type: 'bug', title: 'Crash', description: 'It crashed', component: 'android' };
    const res = await a.inject({ method: 'POST', url: '/companion/v1/feedback', headers: auth, payload });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ replayed: false, feedback: { id: 'f1', status: 'open' } });
    expect(JSON.stringify(res.json())).not.toContain('secret');
    expect(d.feedback.submit).toHaveBeenCalledWith(
      { ...payload, priority: 'normal' },
      expect.objectContaining({ host_id: null, engine: null, admin_user_id: 7, surface: 'companion', device_id: 'device-1' }),
    );
    d.feedback.submit.mockResolvedValueOnce({ feedback: { id: 'f1', status: 'open', title: 'Bug', component: 'android', created_at: 't', report: { description: 'secret' } }, replayed: true });
    expect((await a.inject({ method: 'POST', url: '/companion/v1/feedback', headers: auth, payload })).statusCode).toBe(200);
    for (const bad of [{ ...payload, agent_uuid: randomUUID() }, { ...payload, type: 'praise' }, { ...payload, description: '' }])
      expect((await a.inject({ method: 'POST', url: '/companion/v1/feedback', headers: auth, payload: bad })).statusCode).toBe(422);
  });
});

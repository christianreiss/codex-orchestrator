import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError } from '../../../src/http/errors.js';
import type { ToolContext } from '../../../src/services/chatty/tools.js';
const methods = vi.hoisted(() => ({
  state: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  versions: vi.fn(),
  mutate: vi.fn(),
  runList: vi.fn(),
  runGet: vi.fn(),
  events: vi.fn(),
  report: vi.fn(),
  taskDetail: vi.fn(),
}));
vi.mock('../../../src/services/workflows.js', () => ({
  WorkflowsService: class {
    state = methods.state;
    list = methods.list;
    get = methods.get;
    versions = methods.versions;
    mutate = methods.mutate;
    runList = methods.runList;
    runGet = methods.runGet;
    events = methods.events;
    report = methods.report;
    taskDetail = methods.taskDetail;
  },
}));
import { workflowTools } from '../../../src/services/chatty/workflow-tools.js';
const request = '11111111-1111-4111-8111-111111111111',
  run = '22222222-2222-4222-8222-222222222222';
const context = {
  db: {},
  env: { PUBLIC_BASE_URL: 'https://fleet.invalid' },
  keyring: {},
  actor: { userId: 41, sessionId: 52 },
} as ToolContext;
const document = {
  schema_version: 1,
  title: 'Release',
  summary: 'Reviewed release',
  goal: { statement: 'Ship', success_criteria: [{ id: 'ready', text: 'Checks pass' }] },
  inputs: [],
  knowledge: [],
  tasks: [
    {
      id: 'verify',
      title: 'Verify',
      instructions: 'Run checks',
      acceptance_criteria: ['Pass'],
      depends_on: [],
      knowledge_ids: [],
    },
  ],
};
const tool = (name: string) => workflowTools().find((t) => t.name === name)!;
beforeEach(() => {
  for (const method of Object.values(methods)) method.mockReset().mockResolvedValue({ okay: true });
});
describe('Chatty workflow tools', () => {
  it('requires strict schemas, confirmations and snapshots while excluding execution', () => {
    const tools = workflowTools();
    expect(new Set(tools.map((t) => t.name)).size).toBe(15);
    expect(tools.filter((t) => t.write).map((t) => t.name)).toEqual([
      'workflow_state_set',
      'workflow_create',
      'workflow_revise',
      'workflow_archive',
      'workflow_restore',
      'workflow_revert',
    ]);
    for (const t of tools) {
      expect(t.parameters).toMatchObject({ type: 'object', additionalProperties: false });
      expect(() => t.parse({ unexpected: true })).toThrow();
      expect(t.capability).toBe(t.write ? 'workflows.manage' : 'workflows.read');
      if (t.write) {
        expect(t.confirm).toBe(true);
        expect(t.snapshot).toBeTypeOf('function');
      }
    }
    expect(tool('workflows_list').parse({})).toEqual({ cursor: 0, limit: 50 });
    expect(() => tool('workflow_runs_list').parse({ limit: 101 })).toThrow();
    expect(() => tool('workflow_runs_list').parse({ cursor: -1 })).toThrow();
    for (const name of ['workflow_run_create', 'workflow_run_control', 'workflow_run_prepare_cancel'])
      expect(tools.some((t) => t.name === name)).toBe(false);
  });
  it.each([
    ['workflow_state_set', 'state', { enabled: false }],
    ['workflow_create', 'create', { slug: 'release', document, reason: 'Reusable' }],
    [
      'workflow_revise',
      'revise',
      { workflow_id: 'release', expected_workflow_version: 2, document, reason: 'Improve' },
    ],
    [
      'workflow_archive',
      'archive',
      {
        workflow_id: 'release',
        expected_workflow_version: 2,
        expected_control_version: 3,
        reason: 'Retired',
      },
    ],
    [
      'workflow_restore',
      'archive',
      { workflow_id: 'release', expected_workflow_version: 2, expected_control_version: 3, reason: 'Needed' },
    ],
    [
      'workflow_revert',
      'revert',
      { workflow_id: 'release', expected_workflow_version: 2, version: 1, reason: 'Restore' },
    ],
  ] as const)(
    'delegates %s with authenticated admin identity and idempotency/version guards',
    async (name, operation, fields) => {
      const args = { client_request_id: request, ...fields };
      await tool(name).run(context, args);
      expect(methods.mutate).toHaveBeenCalledOnce();
      expect(methods.mutate).toHaveBeenCalledWith(
        operation,
        {
          ...args,
          ...(name === 'workflow_archive'
            ? { action: 'archive' }
            : name === 'workflow_restore'
              ? { action: 'restore' }
              : {}),
        },
        { kind: 'admin', id: '41' },
      );
      expect(() => tool(name).parse({ ...args, actor: { kind: 'admin', id: '999' } })).toThrow();
      expect(() => tool(name).parse({ ...args, client_request_id: 'bad' })).toThrow();
    },
  );
  it('reuses canonical document validation and propagates service conflicts', async () => {
    const entry = tool('workflow_revise'),
      args = {
        client_request_id: request,
        workflow_id: 'release',
        expected_workflow_version: 2,
        document,
        reason: 'Improve',
      };
    for (const invalid of [
      { ...args, expected_workflow_version: undefined },
      { ...args, expected_workflow_version: 0 },
      { ...args, source_run_id: run },
      { ...args, reason: '   ' },
      { ...args, document: { ...document, tasks: [{ ...document.tasks[0], depends_on: ['verify'] }] } },
      { ...args, document: { ...document, injected: true } },
    ])
      expect(() => entry.run(context, invalid)).toThrow();
    expect(methods.mutate).not.toHaveBeenCalled();
    expect(() =>
      tool('workflow_archive').parse({
        client_request_id: request,
        workflow_id: 'release',
        expected_workflow_version: 2,
        reason: 'Retire',
      }),
    ).toThrow();
    const conflict = new ConflictError('Version changed', 'workflow_version_conflict');
    methods.mutate.mockRejectedValueOnce(conflict);
    await expect(entry.run(context, args)).rejects.toBe(conflict);
  });
  it('snapshots the current definition and immutable revert source, suppressing only absent-workflow errors', async () => {
    const current = { workflow_id: 'w', version: 2 },
      source = { workflow_id: 'w', version: 1 };
    methods.get.mockResolvedValueOnce(current).mockResolvedValueOnce(source);
    expect(
      await tool('workflow_revert').snapshot!(context, {
        client_request_id: request,
        workflow_id: 'release',
        expected_workflow_version: 2,
        version: 1,
        reason: 'Restore',
      }),
    ).toEqual({ current, source });
    expect(methods.get.mock.calls).toEqual([['release'], ['release', 1]]);
    methods.get.mockRejectedValueOnce(new NotFoundError('Missing', 'workflow_not_found'));
    expect(
      await tool('workflow_create').snapshot!(context, {
        client_request_id: request,
        slug: 'release',
        document,
        reason: 'New',
      }),
    ).toBeNull();
    const unavailable = new Error('Owner lost');
    methods.get.mockRejectedValueOnce(unavailable);
    await expect(
      tool('workflow_create').snapshot!(context, {
        client_request_id: request,
        slug: 'release',
        document,
        reason: 'New',
      }),
    ).rejects.toBe(unavailable);
  });
  it.each([
    ['workflow_state_read', 'state', {}, []],
    [
      'workflows_list',
      'list',
      { search: 'release', status: 'archived', limit: 10 },
      [{ search: 'release', status: 'archived', cursor: 0, limit: 10 }],
    ],
    ['workflow_read', 'get', { workflow_id: 'release', version: 1 }, ['release', 1]],
    [
      'workflow_versions',
      'versions',
      { workflow_id: 'release', cursor: 5 },
      ['release', { cursor: 5, limit: 50 }],
    ],
    ['workflow_runs_list', 'runList', { status: 'blocked' }, [{ status: 'blocked', cursor: 0, limit: 50 }]],
    ['workflow_run_read', 'runGet', { run_id: run }, [run, { cursor: 0, limit: 50 }]],
    ['workflow_run_events', 'events', { run_id: run, cursor: 6 }, [run, { cursor: 6, limit: 50 }]],
    ['workflow_run_report', 'report', { run_id: run }, [run]],
    [
      'workflow_run_task_read',
      'taskDetail',
      { run_id: run, task_id: 'verify' },
      [run, 'verify', { cursor: 0, limit: 50 }],
    ],
  ] as const)(
    'delegates read %s without mutation and sanitizes returned data',
    async (name, method, args, expected) => {
      methods[method].mockResolvedValueOnce({ name: 'Visible', token: 'hidden' });
      expect(await tool(name).run(context, args)).toEqual({ name: 'Visible' });
      expect(methods[method]).toHaveBeenCalledWith(...expected);
      expect(methods.mutate).not.toHaveBeenCalled();
    },
  );
});

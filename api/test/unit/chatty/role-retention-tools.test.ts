import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/services/chatty/tools.js';
const mocks = vi.hoisted(() => ({
  role: Object.fromEntries(
    [
      'isEnabled',
      'setEnabled',
      'listAdmin',
      'detailAdmin',
      'createRole',
      'updateRole',
      'saveDraft',
      'discardDraft',
      'publishDraft',
      'revert',
      'withdraw',
      'proposalDetail',
      'decide',
      'timeline',
      'versionContent',
    ].map((name) => [name, vi.fn()]),
  ),
  retentionStatus: vi.fn(),
  saveRetentionPolicy: vi.fn(),
  previewRetention: vi.fn(),
  requestRetentionRun: vi.fn(),
  retentionRun: vi.fn(),
}));
vi.mock('../../../src/services/roles.js', () => ({
  RolesService: vi.fn(function () {
    return mocks.role;
  }),
}));
vi.mock('../../../src/services/settings.js', () => ({ SettingsService: vi.fn() }));
vi.mock('../../../src/services/agent-messaging.js', () => ({
  createAgentMessagingService: vi.fn(() => ({})),
}));
vi.mock('../../../src/services/server-retention/admin.js', () => mocks);
import { roleRetentionTools } from '../../../src/services/chatty/role-retention-tools.js';
const context = { db: {}, env: {}, keyring: {}, actor: { userId: 37, sessionId: 81 } } as ToolContext;
const tool = (name: string) => roleRetentionTools().find((t) => t.name === name)!;
const id = 'e4007300-d648-48ef-94c5-f3ebce079831';
const revision = 'a'.repeat(64);
beforeEach(() => vi.clearAllMocks());
describe('role and retention administration tools', () => {
  it('requires explicit confirmation for every mutation with the owning capability', () => {
    const tools = roleRetentionTools();
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) {
      expect(t.capability).toBe(
        `${t.name.startsWith('server_retention_') ? 'settings' : 'content'}.${t.write ? 'manage' : 'read'}`,
      );
      expect(t.confirm).toBe(t.write);
      if (t.write) expect(t.snapshot).toBeTypeOf('function');
      expect(() => t.parse({ unexpected: true })).toThrow();
    }
  });
  it('rejects unknown nested policy fields, invalid bounds and missing concurrency revisions', () => {
    expect(() =>
      tool('role_update').parse({ slug: 'reviewer', policy: { daily_budget: 1001 }, expected_version: 1 }),
    ).toThrow();
    expect(() =>
      tool('role_update').parse({ slug: 'reviewer', policy: { administrator: true }, expected_version: 1 }),
    ).toThrow();
    expect(() => tool('role_update').parse({ slug: 'reviewer', status: 'retired' })).toThrow();
    expect(() =>
      tool('server_retention_policy_set').parse({
        policy: { audit_days: 0, history_hours: 24, quota_days: 7, armed: true },
        expected_revision: revision,
      }),
    ).toThrow();
    expect(() => tool('server_retention_run').parse({ client_request_id: id })).toThrow();
    expect(() => tool('role_proposal_decide').parse({ id, verdict: 'accept', reason: 'verified' })).toThrow();
  });
  it('passes the authenticated admin actor without leaking routing fields into domain bodies', async () => {
    const draft = { manifest: '---\nname: reviewer\n---\nReview changes.', files: [], changelog: 'Initial' };
    await tool('role_draft_save').run(context, { slug: 'reviewer', ...draft });
    expect(mocks.role.saveDraft).toHaveBeenCalledWith('reviewer', draft, {
      kind: 'admin',
      admin_user_id: 37,
    });
    await tool('role_proposal_decide').run(context, {
      id,
      verdict: 'reject',
      reason: 'Unsupported change',
      expected_version: 4,
    });
    expect(mocks.role.decide).toHaveBeenCalledWith(
      id,
      { verdict: 'reject', reason: 'Unsupported change', expected_version: 4 },
      { kind: 'admin', admin_user_id: 37 },
    );
    await tool('role_create').run(context, {
      slug: 'reviewer',
      display_name: 'Reviewer',
      summary: 'Reviews changes',
    });
    expect(mocks.role.createRole).toHaveBeenCalledWith(
      { slug: 'reviewer', display_name: 'Reviewer', summary: 'Reviews changes' },
      { kind: 'admin', admin_user_id: 37 },
    );
  });
  it('rejects invalid arguments before invoking the mutation', async () => {
    expect(() =>
      tool('role_withdraw').run(context, { slug: 'reviewer', version: 0, reason: 'bad' }),
    ).toThrow();
    expect(mocks.role.withdraw).not.toHaveBeenCalled();
  });
  it('snapshots policy/revision/run while excluding observation clocks and due flags', async () => {
    const policy = { audit_days: 14, history_hours: 24, quota_days: 7, armed: true },
      run = { id, status: 'running' };
    mocks.retentionStatus.mockReturnValue({
      policy,
      revision,
      run,
      observed_at: 'later',
      obligations: [{ due: true }],
    });
    expect(
      await tool('server_retention_run').snapshot!(context, {
        client_request_id: id,
        expected_revision: revision,
      }),
    ).toEqual({ policy, revision, run });
    expect(mocks.requestRetentionRun).not.toHaveBeenCalled();
  });
  it('returns asynchronous cleanup admission without claiming completed deletion', async () => {
    const accepted = { id, status: 'running', counts: {} };
    mocks.requestRetentionRun.mockResolvedValue(accepted);
    expect(
      await tool('server_retention_run').run(context, { client_request_id: id, expected_revision: revision }),
    ).toEqual(accepted);
    expect(mocks.requestRetentionRun).toHaveBeenCalledWith(context.db, {
      client_request_id: id,
      expected_revision: revision,
    });
    expect(tool('server_retention_run').description).toContain(
      'Acceptance does not prove deletion completed',
    );
  });
});

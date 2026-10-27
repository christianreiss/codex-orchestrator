import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/services/chatty/tools.js';

const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  upsert: vi.fn(),
  remove: vi.fn(),
  audit: vi.fn(),
  publish: vi.fn(),
  mutate: vi.fn(),
  getAccount: vi.fn(),
  readPolicy: vi.fn(),
  owner: {},
  currentAccount: { id: 7, engine: 'claude' },
}));
vi.mock('../../../src/control-plane/state/runtime.js', () => ({
  ownerRuntimeFor: () => mocks.owner,
  mutateOwnerState: mocks.mutate,
}));
vi.mock('../../../src/control-plane/state/admin.js', () => ({ adminAudit: mocks.audit }));
vi.mock('../../../src/control-plane/state/rows.js', () => ({
  stageDelete: (_c: unknown, table: string, key: string) => mocks.remove(table, key),
}));
vi.mock('../../../src/ws/publisher.js', () => ({ wsPublisher: { publish: mocks.publish } }));
vi.mock('../../../src/services/settings.js', () => ({
  SettingsService: class {
    getRaw(key: string) {
      return Promise.resolve(mocks.values.get(key) ?? null);
    }
    getString(key: string, fallback = null) {
      return Promise.resolve(mocks.values.get(key) ?? fallback);
    }
    getInt(key: string, fallback: number) {
      return Promise.resolve(Number(mocks.values.get(key) ?? fallback));
    }
    getFlag(key: string, fallback: boolean) {
      return Promise.resolve(mocks.values.has(key) ? mocks.values.get(key) === '1' : fallback);
    }
  },
}));
vi.mock('../../../src/services/provider-accounts.js', () => ({
  ProviderAccountsService: class {
    get = mocks.getAccount;
  },
}));
vi.mock('../../../src/services/quota-policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/quota-policy.js')>()),
  readQuotaPolicy: mocks.readPolicy,
}));
import { quotaTools } from '../../../src/services/chatty/quota-tools.js';
import { DEFAULT_QUOTA_POLICY } from '../../../src/services/quota-policy.js';

const context = { db: {}, keyring: {}, actor: { userId: 42 } } as unknown as ToolContext;
const tool = (name: string) => quotaTools().find((t) => t.name === name)!;
const policy = { ...DEFAULT_QUOTA_POLICY, short_warn_percent: 72 };
const advice = {
  mode: 'hint',
  high_usage_percent: 80,
  projected_usage_percent: 120,
  min_pressure_gap: 10,
  max_age_minutes: 20,
  remember_day: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.values.clear();
  mocks.currentAccount = { id: 7, engine: 'claude' };
  mocks.getAccount.mockResolvedValue(mocks.currentAccount);
  mocks.readPolicy.mockResolvedValue({
    defaults: DEFAULT_QUOTA_POLICY,
    override: null,
    effective: DEFAULT_QUOTA_POLICY,
  });
  mocks.mutate.mockImplementation(async (_owner, mutation) =>
    mutation.prepare({
      snapshot: { table: () => ({ get: () => mocks.currentAccount }) },
      draft: { upsert: mocks.upsert },
      write: vi.fn(),
    }),
  );
});

describe('Chatty quota administration', () => {
  it('matches route capabilities and requires confirmation and snapshots for every write', () => {
    const expected = {
      quota_policy_read: 'settings.read',
      quota_policy_update: 'settings.manage',
      account_quota_policy_read: 'auth.read_metadata',
      account_quota_policy_update: 'auth.manage',
      quota_mode_read: 'settings.read',
      quota_mode_update: 'settings.manage',
      quota_advice_read: 'settings.read',
      quota_advice_update: 'settings.manage',
      quota_scaling_read: 'settings.read',
      quota_scaling_update: 'settings.manage',
    };
    expect(quotaTools().map((t) => [t.name, t.capability])).toEqual(Object.entries(expected));
    for (const entry of quotaTools()) {
      expect(entry.write).toBe(entry.name.endsWith('_update'));
      if (entry.write) {
        expect(entry.confirm).toBe(true);
        expect(entry.snapshot).toBeTypeOf('function');
      }
    }
  });
  it('rejects unknown fields, nonnumeric IDs, invalid percentages and partial policies before mutations', async () => {
    for (const [name, args] of [
      ['quota_policy_update', { engine: 'other', policy }],
      ['quota_policy_update', { engine: 'codex', policy: { ...policy, unlimited: 'yes' } }],
      ['quota_policy_update', { engine: 'codex', policy: { unlimited: true } }],
      ['account_quota_policy_update', { id: '7', policy }],
      ['quota_mode_update', { hard_fail: true, limit_percent: 49, week_partition: 'off' }],
      ['quota_advice_update', { advice: { ...advice, projected_usage_percent: 99 } }],
      ['quota_scaling_update', { enabled: true, tiers: [{ at_percent: 101 }] }],
      ['quota_scaling_update', { enabled: true, tiers: [{ at_percent: 70, shell: 'id' }] }],
      ['quota_mode_read', { unexpected: true }],
    ] as const)
      expect(() => tool(name).parse(args)).toThrow();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('delegates policy reads and binds account inheritance snapshots to engine and override keys', async () => {
    await tool('account_quota_policy_read').run(context, { id: 7 });
    expect(mocks.readPolicy).toHaveBeenCalledWith(context.db, 'claude', 7);
    mocks.values.set('quota_policy_claude', JSON.stringify(policy));
    const snapshot = await tool('account_quota_policy_update').snapshot!(context, { id: 7, policy: null });
    expect(snapshot).toEqual({
      id: 7,
      engine: 'claude',
      settings: { quota_policy_claude: JSON.stringify(policy), quota_policy_account_7: null },
    });
  });
  it('stores an account policy in one attributed owner command with a result for the receipt', async () => {
    const result = await tool('account_quota_policy_update').run(context, { id: 7, policy });
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0]![1]).toMatchObject({
      principal: 'admin:42',
      kind: 'quota.policy.updated',
    });
    expect(mocks.upsert).toHaveBeenCalledWith(
      'versions',
      expect.objectContaining({ name: 'quota_policy_account_7', version: JSON.stringify(policy) }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'quota.policy.updated',
      expect.objectContaining({ user_id: 42, account_id: 7 }),
      expect.any(String),
    );
    expect(result).toEqual({ defaults: DEFAULT_QUOTA_POLICY, override: policy, effective: policy });
    expect(mocks.publish).toHaveBeenCalledWith('quota.policy.updated', { engine: 'claude', account_id: 7 });
  });
  it('resets policies and refuses an account that changes during preparation', async () => {
    await tool('quota_policy_update').run(context, { engine: 'grok', policy: null });
    expect(mocks.remove).toHaveBeenCalledWith('versions', 'quota_policy_grok');
    mocks.currentAccount = { id: 7, engine: 'grok' };
    await expect(tool('account_quota_policy_update').run(context, { id: 7, policy })).rejects.toThrow(
      'Quota account changed',
    );
  });
  it('changes quota mode atomically and preserves omitted advice', async () => {
    mocks.values.set('quota_advice', JSON.stringify(advice));
    const result = await tool('quota_mode_update').run(context, {
      hard_fail: false,
      limit_percent: 90,
      week_partition: '5',
    });
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls.map((c) => c[1].name)).toEqual([
      'quota_hard_fail',
      'quota_limit_percent',
      'quota_week_partition',
    ]);
    expect(result).toEqual({ hard_fail: false, limit_percent: 90, week_partition: '5', advice });
  });
  it('reads and stores scaling through the existing rules shape in threshold order', async () => {
    mocks.values.set('usage_scaling_rules', JSON.stringify({ enabled: false, tiers: [] }));
    expect(await tool('quota_scaling_read').run(context, {})).toEqual({
      enabled: false,
      rules: { enabled: false, tiers: [] },
      active_tier: null,
    });
    const result = await tool('quota_scaling_update').run(context, {
      enabled: true,
      tiers: [{ at_percent: 90, reasoning_effort: 'low' }, { at_percent: 50 }],
    });
    expect(result).toMatchObject({
      enabled: true,
      active_tier: null,
      rules: { tiers: [{ at_percent: 50 }, { at_percent: 90, reasoning_effort: 'low' }] },
    });
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
  it('updates advice independently and preserves quota enforcement settings', async () => {
    mocks.values.set('quota_hard_fail', '1');
    mocks.values.set('quota_limit_percent', '95');
    expect(await tool('quota_advice_update').run(context, { advice })).toEqual(advice);
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls.map((call) => call[1].name)).toEqual(['quota_advice']);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'admin.quota_mode',
      expect.objectContaining({ user_id: 42, changes: { quota_advice: JSON.stringify(advice) } }),
      expect.any(String),
    );
  });
});

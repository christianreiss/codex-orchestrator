import { z } from 'zod';
import { versions } from '../../db/schema.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';
import { mutateOwnerState, ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { stageDelete } from '../../control-plane/state/rows.js';
import { adminAudit } from '../../control-plane/state/admin.js';
import { SettingsService } from '../settings.js';
import { ProviderAccountsService } from '../provider-accounts.js';
import { quotaPolicySchema, quotaPolicyKey, readQuotaPolicy, DEFAULT_QUOTA_POLICY } from '../quota-policy.js';
import { readQuotaAdvice, parseQuotaAdvice, QUOTA_ADVICE_KEY } from '../quota-advice.js';
import { UsageScalingService } from '../usage-scaling.js';
import { wsPublisher } from '../../ws/publisher.js';
import { engineSchema } from './contracts.js';
import { define } from './tool-definition.js';
import type { ChattyTool, ToolContext } from './tools.js';
import type { Engine } from '../../util/engine.js';
import type { Json } from '../../control-plane/commands.js';

const id = z.number().int().positive();
const adviceSchema = z
  .object({
    mode: z.enum(['off', 'hint', 'ask']),
    high_usage_percent: z.number().int().min(1).max(100),
    projected_usage_percent: z.number().int().min(100).max(500),
    min_pressure_gap: z.number().int().min(1).max(100),
    max_age_minutes: z.number().int().min(1).max(120),
    remember_day: z.boolean(),
  })
  .strict();
const modeShape = {
  hard_fail: z.boolean(),
  limit_percent: z.number().int().min(50).max(100),
  week_partition: z.enum(['off', '5', '7']),
  advice: adviceSchema.optional(),
};
const scalingShape = {
  enabled: z.boolean(),
  tiers: z.array(
    z
      .object({
        at_percent: z.number().min(0).max(100),
        lane: z.enum(['normal', 'spark']).optional(),
        reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
        model: z.string().nullable().optional(),
      })
      .strict(),
  ),
};
const modeKeys = ['quota_hard_fail', 'quota_limit_percent', 'quota_week_partition', QUOTA_ADVICE_KEY];
const settings = (c: ToolContext) => new SettingsService(c.db);
const scaling = (c: ToolContext) => new UsageScalingService(settings(c));
/** Reuse canonical scaling validation without issuing a separate settings command. */
class ScalingDraftSettings extends SettingsService {
  private rules: string | null = null;
  override async set(key: string, value: string): Promise<void> {
    if (key !== 'usage_scaling_rules') throw new Error('Unexpected scaling setting');
    this.rules = value;
  }
  override async getRaw(key: string): Promise<string | null> {
    if (key !== 'usage_scaling_rules') throw new Error('Unexpected scaling setting');
    return this.rules;
  }
}
const account = (c: ToolContext, accountId: number) =>
  new ProviderAccountsService(c.db, c.keyring).get(accountId);
async function rawSnapshot(c: ToolContext, keys: string[]) {
  return Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await settings(c).getRaw(key)])));
}
async function mode(c: ToolContext) {
  const service = settings(c);
  const limit = await service.getInt('quota_limit_percent', 95);
  const partition = await service.getString('quota_week_partition', 'off');
  return {
    hard_fail: await service.getFlag('quota_hard_fail', true),
    limit_percent: Math.max(50, Math.min(100, limit)),
    week_partition: partition && ['off', '5', '7'].includes(partition) ? partition : 'off',
    advice: await readQuotaAdvice(service),
  };
}

/** One owner command keeps policy, audit, and the enclosing Chatty receipt atomic. */
async function store(
  c: ToolContext,
  kind: string,
  changes: Record<string, string | null>,
  result: Record<string, unknown>,
  accountGuard?: { id: number; engine: Engine },
  policyEngine?: Engine,
) {
  const owner = ownerRuntimeFor(c.db);
  if (!owner) throw new ConflictError('Quota changes require the active control-plane owner');
  const saved = await mutateOwnerState(owner, {
    kind,
    principal: `admin:${c.actor.userId}`,
    payload: { changes, account_id: accountGuard?.id ?? null },
    prepare(command) {
      if (
        accountGuard &&
        command.snapshot.table('providerAccounts').get(accountGuard.id)?.engine !== accountGuard.engine
      )
        throw new NotFoundError('Quota account changed or was removed');
      const now = new Date().toISOString();
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) stageDelete(command, 'versions', key);
        else {
          const row = { name: key, version: value, updatedAt: now };
          command.draft.upsert('versions', row);
          command.write(async (tx) =>
            tx
              .insert(versions)
              .values(row)
              .onDuplicateKeyUpdate({ set: { version: value, updatedAt: now } }),
          );
        }
      }
      adminAudit(
        command,
        kind,
        { user_id: c.actor.userId, account_id: accountGuard?.id ?? null, changes },
        now,
      );
      return JSON.parse(JSON.stringify(result)) as Json;
    },
  });
  for (const key of Object.keys(changes)) wsPublisher.publish('settings.changed', { key });
  if (kind === 'quota.policy.updated')
    wsPublisher.publish('quota.policy.updated', {
      engine: policyEngine,
      account_id: accountGuard?.id ?? null,
    });
  return saved;
}
async function updatePolicy(
  c: ToolContext,
  engine: Engine,
  policy: z.infer<typeof quotaPolicySchema> | null,
  accountId?: number,
) {
  const current = await readQuotaPolicy(c.db, engine, accountId);
  const defaults = accountId === undefined ? (policy ?? DEFAULT_QUOTA_POLICY) : current.defaults;
  const override = accountId === undefined ? null : policy;
  return store(
    c,
    'quota.policy.updated',
    { [quotaPolicyKey(engine, accountId)]: policy === null ? null : JSON.stringify(policy) },
    { defaults, override, effective: override ?? defaults },
    accountId === undefined ? undefined : { id: accountId, engine },
    engine,
  );
}

export function quotaTools(): ChattyTool[] {
  return [
    define(
      'quota_policy_read',
      'Read the fleet quota policy for one engine.',
      'settings.read',
      { engine: engineSchema },
      (c, a) => readQuotaPolicy(c.db, a.engine),
    ),
    define(
      'quota_policy_update',
      'Replace an engine quota policy, or reset it to built-in defaults with null.',
      'settings.manage',
      { engine: engineSchema, policy: quotaPolicySchema.nullable() },
      (c, a) => updatePolicy(c, a.engine, a.policy),
      {
        confirm: true,
        snapshot: (c, a) => rawSnapshot(c, [quotaPolicyKey(a.engine)]),
        href: () => '/admin/settings',
      },
    ),
    define(
      'account_quota_policy_read',
      'Read an account quota override and its inherited engine policy.',
      'auth.read_metadata',
      { id },
      async (c, a) => {
        const row = await account(c, a.id);
        return readQuotaPolicy(c.db, row.engine as Engine, a.id);
      },
    ),
    define(
      'account_quota_policy_update',
      'Replace an account quota override, or inherit engine defaults with null.',
      'auth.manage',
      { id, policy: quotaPolicySchema.nullable() },
      async (c, a) => {
        const row = await account(c, a.id);
        return updatePolicy(c, row.engine as Engine, a.policy, a.id);
      },
      {
        confirm: true,
        snapshot: async (c, a) => {
          const row = await account(c, a.id);
          return {
            id: row.id,
            engine: row.engine,
            settings: await rawSnapshot(c, [
              quotaPolicyKey(row.engine as Engine),
              quotaPolicyKey(row.engine as Engine, a.id),
            ]),
          };
        },
        href: () => '/admin/accounts',
      },
    ),
    define(
      'quota_mode_read',
      'Read quota admission limits, weekly partitioning, and advice.',
      'settings.read',
      {},
      mode,
    ),
    define(
      'quota_mode_update',
      'Set quota admission limits and weekly partitioning, optionally replacing advice.',
      'settings.manage',
      modeShape,
      async (c, a) => {
        const advice = a.advice ?? (await readQuotaAdvice(settings(c)));
        return store(
          c,
          'admin.quota_mode',
          {
            quota_hard_fail: a.hard_fail ? '1' : '0',
            quota_limit_percent: String(a.limit_percent),
            quota_week_partition: a.week_partition,
            ...(a.advice ? { [QUOTA_ADVICE_KEY]: JSON.stringify(parseQuotaAdvice(a.advice)) } : {}),
          },
          { ...a, advice },
        );
      },
      {
        confirm: true,
        snapshot: (c) => rawSnapshot(c, modeKeys),
        href: () => '/admin/limits#quota-enforcement',
      },
    ),
    define(
      'quota_advice_read',
      'Read quota pressure advice and account-switch prompting settings.',
      'settings.read',
      {},
      (c) => readQuotaAdvice(settings(c)),
    ),
    define(
      'quota_advice_update',
      'Replace quota pressure advice settings without changing admission limits.',
      'settings.manage',
      { advice: adviceSchema },
      (c, a) =>
        store(
          c,
          'admin.quota_mode',
          { [QUOTA_ADVICE_KEY]: JSON.stringify(parseQuotaAdvice(a.advice)) },
          a.advice,
        ),
      {
        confirm: true,
        snapshot: (c) => rawSnapshot(c, [QUOTA_ADVICE_KEY]),
        href: () => '/admin/limits#quota-enforcement',
      },
    ),
    define(
      'quota_scaling_read',
      'Read usage scaling rules; no provider refresh or host mutation.',
      'settings.read',
      {},
      (c) => scaling(c).currentStatus(),
    ),
    define(
      'quota_scaling_update',
      'Replace usage scaling rules. This stores policy and does not launch host work.',
      'settings.manage',
      scalingShape,
      async (c, a) => {
        const staged = new UsageScalingService(new ScalingDraftSettings(c.db));
        const errors = await staged.storeRules(a);
        if (errors.length) throw new ConflictError(errors.join('; '));
        const result = await staged.currentStatus();
        return store(
          c,
          'admin.scaling',
          { usage_scaling_rules: JSON.stringify(result.rules) },
          { ...result },
        );
      },
      {
        confirm: true,
        snapshot: (c) => rawSnapshot(c, ['usage_scaling_rules']),
        href: () => '/admin/limits#scaling-rules',
      },
    ),
  ];
}

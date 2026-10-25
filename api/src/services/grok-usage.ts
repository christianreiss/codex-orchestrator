import { sameQuotaObservation } from '../control-plane/state/quota.js';
import { ownerRuntimeFor, mutateOwnerState } from '../control-plane/state/runtime.js';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { grokUsageSnapshots, providerAccounts } from '../db/schema.js';
import { isRfc3339 } from '../util/timestamp.js';
import { readFleetEngineState } from './engine-switch.js';
import { selectGrokCredential, GROK_AUTH_TARGET } from './grok-auth.js';
import type { createGrokAuthOwner } from './grok-auth-owner.js';
import { wsPublisher } from '../ws/publisher.js';
import { grokPlanName, providerPlan } from './provider-plan.js';

export const GROK_USAGE_URL = `https://${GROK_AUTH_TARGET}/v1/billing?format=credits`;
export const GROK_SETTINGS_URL = `https://${GROK_AUTH_TARGET}/v1/settings`;
export const GROK_USAGE_INTERVAL_MS = 300_000;
export const GROK_USAGE_STALE_MS = 600_000;

export interface GrokUsageWindow {
  used_percent: number;
  period: 'weekly' | 'monthly' | null;
  starts_at: string | null;
  resets_at: string | null;
  shared: boolean | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && isRfc3339(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function cents(value: unknown): number | null {
  const r = record(value);
  if (!r) return null;
  // Protobuf omits zero-valued Cent.val; nonzero int64 values may be strings.
  const raw = r.val ?? 0;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Grok Build's billing contract, verified against the official CLI and live provider.
 * https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/billing.rs
 */
export function parseGrokUsage(body: unknown): GrokUsageWindow | null {
  const config = record(record(body)?.config);
  if (!config) return null;
  let used = config.creditUsagePercent;
  let legacy = false;
  if (used === undefined || used === null) {
    const limit = cents(config.monthlyLimit),
      spent = cents(config.used);
    if (limit === null || limit === 0 || spent === null) return null;
    used = (spent / limit) * 100;
    legacy = true;
  }
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  const period = record(config.currentPeriod);
  return {
    used_percent: Math.round(used * 100) / 100,
    period:
      period?.type === 'USAGE_PERIOD_TYPE_WEEKLY'
        ? 'weekly'
        : period?.type === 'USAGE_PERIOD_TYPE_MONTHLY' || legacy
          ? 'monthly'
          : null,
    starts_at: timestamp(period?.start ?? config.billingPeriodStart),
    resets_at: timestamp(period?.end ?? config.billingPeriodEnd),
    shared: typeof config.isUnifiedBillingUser === 'boolean' ? config.isUnifiedBillingUser : null,
  };
}

/** Auth-retrieve view of one stored reading. Display only: no enforcement fields. */
export function grokUsageAuthFields(
  reading: {
    fetched_at: string | null;
    stale: boolean;
    current_window: {
      used_percent: number;
      period: 'weekly' | 'monthly' | null;
      resets_at: string | null;
    } | null;
  } | null,
): Record<string, unknown> {
  const window = reading?.current_window;
  if (!reading || !window) return { status: 'unavailable' };
  return {
    status: 'ok',
    used_percent: window.used_percent,
    period: window.period,
    resets_at: window.resets_at,
    fetched_at: reading.fetched_at,
    stale: reading.stale,
  };
}

export async function readGrokUsage(reader: Pick<Database, 'select'>, accountId: number) {
  const owner = ownerRuntimeFor(reader);
  const row = owner
    ? (owner.assertOwner(), owner.state.snapshot().table('grokUsageSnapshots').get(accountId))
    : (
        await reader
          .select()
          .from(grokUsageSnapshots)
          .where(eq(grokUsageSnapshots.accountId, accountId))
          .limit(1)
      )[0];
  const now = Date.now();
  const window: GrokUsageWindow | null =
    row?.usedPercent == null
      ? null
      : {
          used_percent: row.usedPercent,
          period: row.periodType === 'weekly' || row.periodType === 'monthly' ? row.periodType : null,
          starts_at: row.periodStartsAt,
          resets_at: row.periodResetsAt,
          shared: row.shared === null ? null : row.shared === 1,
        };
  return {
    supported: true,
    plan: providerPlan(row?.planName ?? null, 'grok_settings', row?.planFetchedAt, !!row?.planErrorCode),
    fetched_at: row?.fetchedAt ?? null,
    checked_at: row?.checkedAt ?? null,
    error_code: row?.errorCode ?? null,
    stale:
      !window ||
      !!row?.errorCode ||
      !row?.fetchedAt ||
      now - Date.parse(row.fetchedAt) > GROK_USAGE_STALE_MS ||
      (!!window.resets_at && Date.parse(window.resets_at) <= now),
    current_window: window,
    // Dashboard observation only: do not silently introduce Grok quota enforcement
    // or change account assignment/CLI contracts with this display feature.
    short_used_percent: null,
    short_resets_at: null,
    weekly_used_percent: null,
    weekly_resets_at: null,
  };
}

interface GrokUsageDeps {
  db: Database;
  authOwner: Pick<ReturnType<typeof createGrokAuthOwner>, 'ensureFresh'>;
  fetchImpl?: typeof fetch;
}

export class GrokUsageService {
  constructor(private readonly deps: GrokUsageDeps) {}

  async refreshEnabled(): Promise<void> {
    if (!(await readFleetEngineState(this.deps.db, { fresh: true })).grok) return;
    const owner = ownerRuntimeFor(this.deps.db);
    const accounts = owner
      ? owner.state
          .snapshot()
          .accounts.all()
          .filter((a) => a.engine === 'grok' && a.state === 'enabled')
      : await this.deps.db
          .select()
          .from(providerAccounts)
          .where(and(eq(providerAccounts.engine, 'grok'), eq(providerAccounts.state, 'enabled')));
    for (const account of accounts) {
      if (!account.mergedIntoAccountId) await this.refreshAccount(account.id);
    }
  }

  private async eligible(accountId: number): Promise<boolean> {
    const db = this.deps.db;
    if (!(await readFleetEngineState(db, { fresh: true })).grok) return false;
    const owner = ownerRuntimeFor(db);
    const account = owner
      ? owner.state.snapshot().accounts.get(accountId)
      : (await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId)).limit(1))[0];
    return (
      !!account && account.engine === 'grok' && account.state === 'enabled' && !account.mergedIntoAccountId
    );
  }

  async refreshAccount(accountId: number): Promise<void> {
    const { db, authOwner } = this.deps;
    if (!(await this.eligible(accountId))) return;
    const owner = ownerRuntimeFor(db);
    const previous = owner
      ? owner.state.snapshot().table('grokUsageSnapshots').get(accountId)
      : (
          await db
            .select()
            .from(grokUsageSnapshots)
            .where(eq(grokUsageSnapshots.accountId, accountId))
            .limit(1)
        )[0];
    if (previous && Date.now() - Date.parse(previous.checkedAt) < GROK_USAGE_INTERVAL_MS) return;
    let window: GrokUsageWindow | null = null;
    let errorCode: string | null = null;
    let planName: string | null = null;
    let planErrorCode: string | null = 'auth_unavailable';
    let planFetched = false;
    try {
      // All renewal stays with the existing fenced owner. No independent refresh
      // grant, browser cookies, or native unmanaged login is used by this poller.
      const snapshot = await authOwner.ensureFresh({ accountId, minValiditySeconds: 60 });
      const credential = selectGrokCredential(snapshot.auth, true);
      if (!credential) throw new Error('missing credential');
      const headers: Record<string, string> = {
        Authorization: `Bearer ${credential.access}`,
        'X-XAI-Token-Auth': 'xai-grok-cli',
        Accept: 'application/json',
      };
      if (typeof credential.native.user_id === 'string') headers['x-userid'] = credential.native.user_id;
      try {
        const response = await (this.deps.fetchImpl ?? fetch)(GROK_USAGE_URL, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) errorCode = `provider_http_${response.status}`;
        else {
          window = parseGrokUsage(await response.json());
          if (!window) errorCode = 'usage_unavailable';
        }
      } catch {
        errorCode = 'provider_unavailable';
      }
      // Plan freshness is independent of quota freshness. A settings outage
      // retains the prior plan without invalidating a successful quota reading.
      if (!(await this.eligible(accountId))) return;
      try {
        const response = await (this.deps.fetchImpl ?? fetch)(GROK_SETTINGS_URL, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) planErrorCode = `provider_http_${response.status}`;
        else {
          planName = grokPlanName(await response.json());
          planFetched = true;
          planErrorCode = planName ? null : 'plan_unavailable';
        }
      } catch {
        planErrorCode = 'provider_unavailable';
      }
    } catch {
      errorCode = 'auth_unavailable';
    }
    // A suspension/removal during the request must not publish a fresh result.
    if (!(await this.eligible(accountId))) return;
    const checkedAt = new Date().toISOString();
    const values = {
      checkedAt,
      errorCode,
      planErrorCode,
      ...(planFetched ? { planName, planFetchedAt: checkedAt } : {}),
      ...(window
        ? {
            usedPercent: window.used_percent,
            periodType: window.period,
            periodStartsAt: window.starts_at,
            periodResetsAt: window.resets_at,
            shared: window.shared === null ? null : Number(window.shared),
            fetchedAt: checkedAt,
          }
        : {}),
    };
    let changed = true;
    if (owner) {
      await mutateOwnerState(owner, {
        kind: 'provider.grok.usage',
        payload: { accountId, checkedAt },
        prepare(context) {
          const account = context.snapshot.accounts.get(accountId);
          if (
            !account ||
            account.engine !== 'grok' ||
            account.state !== 'enabled' ||
            account.mergedIntoAccountId ||
            ['1', 'true', 'yes', 'on'].includes(context.snapshot.setting('grok_engine_disabled') ?? '')
          )
            return null;
          const old = context.snapshot.table('grokUsageSnapshots').get(accountId);
          if (old && old.checkedAt > checkedAt) return null;
          const row = {
            accountId,
            usedPercent: null,
            periodType: null,
            periodStartsAt: null,
            periodResetsAt: null,
            shared: null,
            fetchedAt: null,
            planName: null,
            planFetchedAt: null,
            ...old,
            ...values,
          };
          if (old && sameQuotaObservation(old, row)) {
            changed = false;
            context.draft.upsert('grokUsageSnapshots', row);
            return null;
          }
          context.write(async (tx) => {
            await tx.insert(grokUsageSnapshots).values(row).onDuplicateKeyUpdate({ set: values });
          });
          context.draft.upsert('grokUsageSnapshots', row);
          return null;
        },
      });
    } else
      await db
        .insert(grokUsageSnapshots)
        .values({ accountId, ...values })
        .onDuplicateKeyUpdate({ set: values });
    if (changed) wsPublisher.publish('accounts.updated', { account_id: accountId });
  }
}

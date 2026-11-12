import { stageEmulation, recordEmulation } from './quota-emulation.js';
import { sameQuotaObservation } from '../control-plane/state/quota.js';
import { ownerRuntimeFor, mutateOwnerState } from '../control-plane/state/runtime.js';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { kimiUsageSnapshots, providerAccounts } from '../db/schema.js';
import { isRfc3339 } from '../util/timestamp.js';
import { readFleetEngineState } from './engine-switch.js';
import { selectKimiCredential } from './kimi-auth.js';
import type { createKimiAuthOwner } from './kimi-auth-owner.js';
import { wsPublisher } from '../ws/publisher.js';
import { kimiPlanName, providerPlan } from './provider-plan.js';

export const KIMI_USAGE_INTERVAL_MS = 300_000;
export const KIMI_USAGE_STALE_MS = 600_000;
export type KimiWindowKind = 'five_hour' | 'weekly' | 'month_total' | 'month_code';
export interface KimiUsageWindow {
  kind: KimiWindowKind;
  used_percent: number;
  resets_at: string | null;
}
function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const windowFields = [
  ['five_hour', 'fiveHour', 'limit_5h'],
  ['weekly', 'weekly', 'limit_7d'],
  ['month_total', 'monthTotal', 'limit_month_total'],
  ['month_code', 'monthCode', 'limit_month_code'],
] as const;
/** Official managed-usage.ts semantics: optional windows, ratio numbers or numeric strings. */
export function parseKimiUsage(
  body: unknown,
): { windows: KimiUsageWindow[]; extra_usage: Record<string, unknown> | null } | null {
  const raw = record(body),
    usages = record(raw?.usages);
  if (!usages) return null;
  const windows: KimiUsageWindow[] = [];
  for (const [kind, , key] of windowFields) {
    const entry = record(usages[key]);
    const ratio =
      typeof entry?.used_ratio === 'number'
        ? entry.used_ratio
        : typeof entry?.used_ratio === 'string' && entry.used_ratio.trim()
          ? Number(entry.used_ratio)
          : NaN;
    if (!Number.isFinite(ratio)) continue;
    const resets = entry?.reset_time;
    windows.push({
      kind,
      used_percent: ratio * 100,
      resets_at: typeof resets === 'string' && isRfc3339(resets) ? new Date(resets).toISOString() : null,
    });
  }
  const wallet = record(raw?.boosterWallet),
    balance = record(wallet?.balance);
  const integer = (v: unknown) =>
    typeof v === 'number' || typeof v === 'string'
      ? Number.isFinite(Number(v))
        ? Math.trunc(Number(v))
        : null
      : null;
  const amount = integer(balance?.amount),
    left = integer(balance?.amountLeft);
  const cents = (n: number) => (n > 0 && n < 1_000_000 ? 1 : Math.round(n / 1_000_000));
  const limit = record(wallet?.monthlyChargeLimit),
    used = record(wallet?.monthlyUsed);
  const extra =
    balance?.type === 'BOOSTER' && amount !== null && amount > 0
      ? {
          balanceCents: cents(left ?? 0),
          totalCents: cents(amount),
          monthlyChargeLimitEnabled: wallet?.monthlyChargeLimitEnabled === true,
          monthlyChargeLimitCents: integer(limit?.priceInCents) ?? 0,
          monthlyUsedCents: integer(used?.priceInCents) ?? 0,
          currency:
            typeof limit?.currency === 'string' && limit.currency
              ? limit.currency
              : typeof used?.currency === 'string' && used.currency
                ? used.currency
                : 'USD',
        }
      : null;
  return { windows, extra_usage: extra };
}
export async function readKimiUsage(reader: Pick<Database, 'select'>, accountId: number) {
  const owner = ownerRuntimeFor(reader);
  const row = owner
    ? (owner.assertOwner(), owner.state.snapshot().table('kimiUsageSnapshots').get(accountId))
    : (
        await reader
          .select()
          .from(kimiUsageSnapshots)
          .where(eq(kimiUsageSnapshots.accountId, accountId))
          .limit(1)
      )[0];
  const windows: KimiUsageWindow[] = [];
  for (const [kind, field] of windowFields) {
    const used = row?.[`${field}UsedPercent`];
    if (typeof used === 'number')
      windows.push({ kind, used_percent: used, resets_at: row?.[`${field}ResetsAt`] ?? null });
  }
  return {
    supported: true,
    plan_name: row?.planName ?? null,
    plan: providerPlan(row?.planName ?? null, 'kimi_userinfo', row?.planFetchedAt, !!row?.planErrorCode),
    windows,
    fetched_at: row?.fetchedAt ?? null,
    checked_at: row?.checkedAt ?? new Date().toISOString(),
    error_code: row?.errorCode ?? null,
    stale:
      !row?.fetchedAt ||
      !!row.errorCode ||
      Date.now() - Date.parse(row.fetchedAt) > KIMI_USAGE_STALE_MS ||
      windows.some((w) => w.resets_at && Date.parse(w.resets_at) <= Date.now()),
    short_used_percent: row?.fiveHourUsedPercent ?? null,
    short_resets_at: row?.fiveHourResetsAt ?? null,
    short_limit_seconds: 18000,
    weekly_used_percent: row?.weeklyUsedPercent ?? null,
    weekly_resets_at: row?.weeklyResetsAt ?? null,
    weekly_limit_seconds: 604800,
  };
}
export function kimiUsageAuthFields(
  reading: Awaited<ReturnType<typeof readKimiUsage>> | null,
): Record<string, unknown> {
  return reading
    ? { ...reading, status: reading.fetched_at ? 'ok' : 'unavailable' }
    : { status: 'unavailable' };
}

interface KimiUsageDeps {
  db: Database;
  authOwner: Pick<ReturnType<typeof createKimiAuthOwner>, 'ensureFresh'>;
  fetchImpl?: typeof fetch;
}

export class KimiUsageService {
  constructor(private readonly deps: KimiUsageDeps) {}

  async refreshEnabled(): Promise<void> {
    if (!(await readFleetEngineState(this.deps.db, { fresh: true })).kimi) return;
    const owner = ownerRuntimeFor(this.deps.db);
    const accounts = owner
      ? owner.state
          .snapshot()
          .accounts.all()
          .filter((a) => a.engine === 'kimi' && a.state === 'enabled')
      : await this.deps.db
          .select()
          .from(providerAccounts)
          .where(and(eq(providerAccounts.engine, 'kimi'), eq(providerAccounts.state, 'enabled')));
    for (const account of accounts) {
      if (!account.mergedIntoAccountId) await this.refreshAccount(account.id);
    }
  }

  private async eligible(accountId: number): Promise<boolean> {
    const db = this.deps.db;
    if (!(await readFleetEngineState(db, { fresh: true })).kimi) return false;
    const owner = ownerRuntimeFor(db);
    const account = owner
      ? owner.state.snapshot().accounts.get(accountId)
      : (await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId)).limit(1))[0];
    return (
      !!account && account.engine === 'kimi' && account.state === 'enabled' && !account.mergedIntoAccountId
    );
  }

  async refreshAccount(accountId: number): Promise<void> {
    const { db, authOwner } = this.deps;
    if (!(await this.eligible(accountId))) return;
    const owner = ownerRuntimeFor(db);
    const previous = owner
      ? owner.state.snapshot().table('kimiUsageSnapshots').get(accountId)
      : (
          await db
            .select()
            .from(kimiUsageSnapshots)
            .where(eq(kimiUsageSnapshots.accountId, accountId))
            .limit(1)
        )[0];
    if (previous && Date.now() - Date.parse(previous.checkedAt) < KIMI_USAGE_INTERVAL_MS) return;
    let window: ReturnType<typeof parseKimiUsage> = null;
    let errorCode: string | null = null;
    let planName: string | null = null;
    let planErrorCode: string | null = 'auth_unavailable';
    let planFetched = false;
    try {
      // All renewal stays with the existing fenced owner. No independent refresh
      // grant, browser cookies, or native unmanaged login is used by this poller.
      const snapshot = await authOwner.ensureFresh({ accountId, minValiditySeconds: 60 });
      const credential = selectKimiCredential(snapshot.auth, true);
      if (!credential) throw new Error('missing credential');
      const headers: Record<string, string> = {
        Authorization: `Bearer ${credential.access}`,
        Accept: 'application/json',
      };
      try {
        const response = await (this.deps.fetchImpl ?? fetch)(`${String(snapshot.auth.base_url)}/usages`, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) errorCode = `provider_http_${response.status}`;
        else {
          window = parseKimiUsage(await response.json());
          if (!window) errorCode = 'usage_unavailable';
        }
      } catch {
        errorCode = 'provider_unavailable';
      }
      // Plan freshness is independent of quota freshness. A settings outage
      // retains the prior plan without invalidating a successful quota reading.
      if (!(await this.eligible(accountId))) return;
      try {
        const response = await (this.deps.fetchImpl ?? fetch)(`${String(snapshot.auth.base_url)}/me`, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) planErrorCode = `provider_http_${response.status}`;
        else {
          planName = kimiPlanName(await response.json());
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
            ...Object.fromEntries(
              windowFields.flatMap(([kind, field]) => {
                const w = window!.windows.find((w) => w.kind === kind);
                return [
                  [`${field}UsedPercent`, w?.used_percent ?? null],
                  [`${field}ResetsAt`, w?.resets_at ?? null],
                ];
              }),
            ),
            extraUsageJson: window.extra_usage ? JSON.stringify(window.extra_usage) : null,
            fetchedAt: checkedAt,
          }
        : {}),
    };
    let changed = true;
    if (owner) {
      await mutateOwnerState(owner, {
        kind: 'provider.kimi.usage',
        payload: { accountId, checkedAt },
        prepare(context) {
          const account = context.snapshot.accounts.get(accountId);
          if (
            !account ||
            account.engine !== 'kimi' ||
            account.state !== 'enabled' ||
            account.mergedIntoAccountId ||
            ['1', 'true', 'yes', 'on'].includes(context.snapshot.setting('kimi_engine_disabled') ?? '')
          )
            return null;
          const old = context.snapshot.table('kimiUsageSnapshots').get(accountId);
          if (old && old.checkedAt > checkedAt) return null;
          const row = {
            accountId,
            fiveHourUsedPercent: null,
            fiveHourResetsAt: null,
            weeklyUsedPercent: null,
            weeklyResetsAt: null,
            monthTotalUsedPercent: null,
            monthTotalResetsAt: null,
            monthCodeUsedPercent: null,
            monthCodeResetsAt: null,
            extraUsageJson: null,
            planErrorCode: null,
            fetchedAt: null,
            planName: null,
            planFetchedAt: null,
            ...old,
            ...values,
          };
          stageEmulation(context, 'kimi', row);
          if (old && sameQuotaObservation(old, row)) {
            changed = false;
            context.draft.upsert('kimiUsageSnapshots', row);
            return null;
          }
          context.write(async (tx) => {
            await tx.insert(kimiUsageSnapshots).values(row).onDuplicateKeyUpdate({ set: values });
          });
          context.draft.upsert('kimiUsageSnapshots', row);
          return null;
        },
      });
    } else {
      await db
        .insert(kimiUsageSnapshots)
        .values({ accountId, ...values })
        .onDuplicateKeyUpdate({ set: values });
      await recordEmulation(db, 'kimi', { accountId, ...values });
    }
    if (changed) wsPublisher.publish('accounts.updated', { account_id: accountId });
  }
}

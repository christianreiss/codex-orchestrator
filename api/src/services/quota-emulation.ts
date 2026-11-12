import { readQuotaPolicy } from './quota-policy.js';
import { ApiError } from '../http/errors.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { quotaEmulationStates, providerAccounts, versions } from '../db/schema.js';
import type { Engine } from '../util/engine.js';
import type { OwnerStateSnapshot } from '../control-plane/state/store.js';
import { ownerRuntimeFor, type OwnerMutationContext } from '../control-plane/state/runtime.js';

export const emulationSettingsSchema = z
  .object({
    enabled: z.boolean(),
    window_hours: z.union([z.literal(5), z.literal(8)]),
    action: z.enum(['suggest_pause', 'suggest_ignore', 'hard_stop']),
    auto_resume: z.boolean(),
  })
  .strict();
export type EmulationSettings = z.infer<typeof emulationSettingsSchema>;
export const DEFAULT_EMULATION: EmulationSettings = {
  enabled: false,
  window_hours: 5,
  action: 'suggest_pause',
  auto_resume: false,
};
export const emulationKey = (engine: Engine) => `quota_emulation_${engine}`;
export function parseEmulation(raw: string | null | undefined): EmulationSettings {
  try {
    return raw ? emulationSettingsSchema.parse(JSON.parse(raw)) : { ...DEFAULT_EMULATION };
  } catch {
    return { ...DEFAULT_EMULATION };
  }
}
export async function readEmulation(db: Pick<Database, 'select'>, engine: Engine) {
  const owner = ownerRuntimeFor(db);
  if (owner) {
    owner.assertOwner();
    return parseEmulation(owner.state.snapshot().setting(emulationKey(engine)));
  }
  const [row] = await db
    .select()
    .from(versions)
    .where(eq(versions.name, emulationKey(engine)));
  return parseEmulation(row?.version);
}
export interface EmulationObservation {
  accountId: number;
  observedAt: string;
  weeklyUsed: number;
  periodResetAt: string;
  nativeShort: boolean;
}
type State = typeof quotaEmulationStates.$inferSelect;

/** A failed/incomplete provider response is never proof that a native window disappeared. */
export function emulationObservation(engine: Engine, value: object): EmulationObservation | null {
  const r = value as Record<string, unknown>;
  if (typeof r.accountId !== 'number' || !r.accountId || typeof r.fetchedAt !== 'string') return null;
  let weeklyUsed: unknown,
    reset: unknown,
    nativeShort = false;
  if (engine === 'codex') {
    if (r.status !== 'ok' && r.status !== 'rate_limited') return null;
    for (const prefix of ['primary', 'secondary']) {
      const duration = r[`${prefix}LimitSeconds`],
        used = r[`${prefix}UsedPercent`];
      if (typeof used !== 'number' || typeof duration !== 'number' || duration <= 0) continue;
      if (duration < 86400) nativeShort = true;
      if (duration === 604800) {
        weeklyUsed = used;
        reset = r[`${prefix}ResetAt`];
      }
    }
  } else if (engine === 'claude') {
    nativeShort = typeof r.fiveHourUsedPercent === 'number';
    weeklyUsed = r.sevenDayUsedPercent;
    reset = r.sevenDayResetsAt;
  } else if (engine === 'kimi') {
    if (r.errorCode) return null;
    nativeShort = typeof r.fiveHourUsedPercent === 'number';
    weeklyUsed = r.weeklyUsedPercent;
    reset = r.weeklyResetsAt;
  } else {
    if (r.errorCode || r.periodType !== 'weekly') return null;
    weeklyUsed = r.usedPercent;
    reset = r.periodResetsAt;
  }
  if (
    typeof weeklyUsed !== 'number' ||
    !Number.isFinite(weeklyUsed) ||
    weeklyUsed < 0 ||
    weeklyUsed > 100 ||
    typeof reset !== 'string' ||
    !Number.isFinite(Date.parse(reset)) ||
    !Number.isFinite(Date.parse(r.fetchedAt)) ||
    Date.parse(reset) <= Date.parse(r.fetchedAt)
  )
    return null;
  return {
    accountId: r.accountId,
    observedAt: r.fetchedAt,
    weeklyUsed,
    periodResetAt: new Date(reset).toISOString(),
    nativeShort,
  };
}

/** Pure transition; timestamps fence retries and out-of-order reports from different hosts. */
export function advanceEmulation(
  previous: State | null,
  o: EmulationObservation,
  engine: Engine,
  settings: EmulationSettings,
): State | null {
  if (!settings.enabled || o.nativeShort) return null;
  if (previous && Date.parse(o.observedAt) <= Date.parse(previous.observedAt)) return previous;
  const baseline: State = {
    accountId: o.accountId,
    engine,
    periodResetAt: o.periodResetAt,
    observedAt: o.observedAt,
    lastUsedPercent: o.weeklyUsed,
    startedAt: null,
    resetsAt: null,
    windowHours: settings.window_hours,
    consumedPercent: 0,
    valid: 1,
  };
  if (!previous || previous.engine !== engine || previous.periodResetAt !== o.periodResetAt) return baseline;
  // A decrease inside the same provider period invalidates, rather than replenishes, a budget.
  if (!previous.valid || o.weeklyUsed < previous.lastUsedPercent)
    return { ...previous, observedAt: o.observedAt, valid: 0 };
  const delta = o.weeklyUsed - previous.lastUsedPercent;
  const active = previous.resetsAt !== null && Date.parse(previous.resetsAt) > Date.parse(o.observedAt);
  if (!active && delta === 0) return baseline;
  const hours = active ? previous.windowHours : settings.window_hours;
  return {
    ...baseline,
    windowHours: hours,
    startedAt: active ? previous.startedAt : o.observedAt,
    resetsAt: active
      ? previous.resetsAt
      : new Date(
          Math.min(Date.parse(o.observedAt) + hours * 3600000, Date.parse(o.periodResetAt)),
        ).toISOString(),
    consumedPercent: (active ? previous.consumedPercent : 0) + delta,
  };
}
export function stageEmulation(context: OwnerMutationContext, engine: Engine, value: object) {
  const o = emulationObservation(engine, value);
  if (!o) return;
  const settings = parseEmulation(context.snapshot.setting(emulationKey(engine)));
  const previous = context.draft.table('quotaEmulationStates').get(o.accountId) ?? null;
  const row = advanceEmulation(
    previous,
    o,
    engine,
    unlimitedAccount(context.snapshot, engine, o.accountId) ? { ...settings, enabled: false } : settings,
  );
  if (row === previous || (!row && !previous)) return;
  if (!row) {
    context.draft.remove('quotaEmulationStates', o.accountId);
    context.write((tx) =>
      tx.delete(quotaEmulationStates).where(eq(quotaEmulationStates.accountId, o.accountId)),
    );
  } else {
    context.draft.upsert('quotaEmulationStates', row);
    context.write((tx) => tx.insert(quotaEmulationStates).values(row).onDuplicateKeyUpdate({ set: row }));
  }
}
export async function recordEmulation(db: Database, engine: Engine, value: object) {
  const o = emulationObservation(engine, value);
  if (!o) return;
  await db.transaction(async (tx) => {
    await tx.select().from(providerAccounts).where(eq(providerAccounts.id, o.accountId)).for('update');
    const [stored] = await tx
      .select()
      .from(quotaEmulationStates)
      .where(eq(quotaEmulationStates.accountId, o.accountId));
    const settings = await readEmulation(tx, engine);
    const unlimited = (await readQuotaPolicy(tx, engine, o.accountId)).effective.unlimited;
    const row = advanceEmulation(
      stored ?? null,
      o,
      engine,
      unlimited ? { ...settings, enabled: false } : settings,
    );
    if (row === stored) return;
    if (!row) await tx.delete(quotaEmulationStates).where(eq(quotaEmulationStates.accountId, o.accountId));
    else await tx.insert(quotaEmulationStates).values(row).onDuplicateKeyUpdate({ set: row });
  });
}
export function emulatedWindow(
  row: State | null | undefined,
  settings: EmulationSettings,
  observation: EmulationObservation | null,
  now: number,
) {
  if (
    !settings.enabled ||
    !row ||
    !row.valid ||
    !observation ||
    observation.nativeShort ||
    row.periodResetAt !== observation.periodResetAt
  )
    return null;
  const active = row.resetsAt !== null && Date.parse(row.resetsAt) > now;
  const fresh =
    Date.parse(observation.observedAt) >= now - 600000 &&
    Date.parse(observation.observedAt) <= now + 30000 &&
    Date.parse(row.periodResetAt) > now;
  return {
    kind: 'short' as const,
    used_percent: active ? Math.round(((row.consumedPercent * 168) / row.windowHours) * 1e9) / 1e9 : 0,
    limit_seconds: (active ? row.windowHours : settings.window_hours) * 3600,
    resets_at: active ? row.resetsAt : null,
    observed_at: observation.observedAt,
    source: 'emulated' as const,
    status: fresh ? ('fresh' as const) : ('stale' as const),
    started_at: active ? row.startedAt : null,
    budget_weekly_percent: (100 * (active ? row.windowHours : settings.window_hours)) / 168,
    consumed_weekly_percent: active ? row.consumedPercent : 0,
    action: settings.action,
  };
}
export function ownedEmulation(s: OwnerStateSnapshot, engine: Engine, accountId: number, now = Date.now()) {
  const settings = parseEmulation(s.setting(emulationKey(engine)));
  const table =
    engine === 'codex'
      ? 'chatgptUsageSnapshots'
      : engine === 'claude'
        ? 'claudeUsageSnapshots'
        : engine === 'kimi' ? 'kimiUsageSnapshots' : 'grokUsageSnapshots';
  const rows = [...s.table(table).by('accountId', accountId)];
  const latest = rows.sort((a, b) => ('id' in b ? Number(b.id) : 0) - ('id' in a ? Number(a.id) : 0))[0];
  const observation = latest ? emulationObservation(engine, latest) : null;
  return {
    settings,
    unlimited: unlimitedAccount(s, engine, accountId),
    window: emulatedWindow(s.table('quotaEmulationStates').get(accountId), settings, observation, now),
  };
}
export function emulationBlocks(
  window: { source: string; status: string; action?: string; used_percent: number } | null | undefined,
) {
  return (
    !!window &&
    window.source === 'emulated' &&
    window.status === 'fresh' &&
    window.action === 'hard_stop' &&
    window.used_percent >= 100
  );
}

function unlimitedAccount(s: OwnerStateSnapshot, engine: Engine, accountId: number) {
  const raw = s.setting(`quota_policy_account_${accountId}`) || s.setting(`quota_policy_${engine}`);
  try {
    return !!raw && JSON.parse(raw).unlimited === true;
  } catch {
    return false;
  }
}
export function assertEmulationAdmission(s: OwnerStateSnapshot, engine: Engine, accountId: number) {
  if (unlimitedAccount(s, engine, accountId)) return;
  const { window } = ownedEmulation(s, engine, accountId);
  if (emulationBlocks(window)) throw emulationLimitError(window!.resets_at!);
}
export function emulationLimitError(resetAt: string) {
  return new ApiError(`Emulated short quota exhausted; reset ${resetAt}`, {
    status: 429,
    code: 'quota_emulation_limit',
    extra: { source: 'emulated', retry_not_before: resetAt },
    headers: { 'retry-after': String(Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000))) },
  });
}

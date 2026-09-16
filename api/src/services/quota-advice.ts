import { SettingsService } from './settings.js';
import { ValidationError } from '../http/errors.js';

export const QUOTA_ADVICE_KEY = 'quota_advice';
export interface QuotaAdviceSettings {
  mode: 'off' | 'hint' | 'ask';
  high_usage_percent: number;
  projected_usage_percent: number;
  min_pressure_gap: number;
  max_age_minutes: number;
  remember_day: boolean;
}
export const DEFAULT_QUOTA_ADVICE: QuotaAdviceSettings = {
  mode: 'ask',
  high_usage_percent: 85,
  projected_usage_percent: 100,
  min_pressure_gap: 20,
  max_age_minutes: 30,
  remember_day: true,
};

export function parseQuotaAdvice(value: unknown): QuotaAdviceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('advice must be an object', { param: 'advice' });
  }
  const v = value as Record<string, unknown>;
  const out = { ...DEFAULT_QUOTA_ADVICE, ...v };
  if (
    typeof out.mode !== 'string' ||
    !['off', 'hint', 'ask'].includes(out.mode) ||
    typeof out.remember_day !== 'boolean'
  ) {
    throw new ValidationError('Invalid advice mode or remember_day', { param: 'advice' });
  }
  for (const [key, min, max] of [
    ['high_usage_percent', 1, 100],
    ['projected_usage_percent', 100, 500],
    ['min_pressure_gap', 1, 100],
    ['max_age_minutes', 1, 120],
  ] as const) {
    if (!Number.isInteger(out[key]) || out[key] < min || out[key] > max) {
      throw new ValidationError(`${key} must be an integer between ${min} and ${max}`, {
        param: `advice.${key}`,
      });
    }
  }
  for (const key of Object.keys(v)) {
    if (!Object.hasOwn(DEFAULT_QUOTA_ADVICE, key))
      throw new ValidationError('Unknown advice setting', { param: `advice.${key}` });
  }
  return out as QuotaAdviceSettings;
}

export async function readQuotaAdvice(settings: SettingsService): Promise<QuotaAdviceSettings> {
  const raw = await settings.getString(QUOTA_ADVICE_KEY);
  if (!raw) return { ...DEFAULT_QUOTA_ADVICE };
  try {
    return parseQuotaAdvice(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_QUOTA_ADVICE, mode: 'off' };
  }
}

// Only quota observations and host engine membership cross this boundary.
// Never include canonical auth payloads or trigger a provider refresh.
export function quotaAdviceSnapshot(
  settings: QuotaAdviceSettings,
  engines: string[],
  codex: Record<string, unknown>,
  claude: Record<string, unknown>,
) {
  const spark = codex.active_quota_lane === 'spark';
  const window = (q: Record<string, unknown>, prefix: string, seconds?: number) => ({
    used_percent: q[`${prefix}_used_percent`] ?? null,
    limit_seconds: seconds ?? q[`${prefix}_limit_seconds`] ?? null,
    reset_at: q[`${prefix}_reset_at`] ?? q[`${prefix}_resets_at`] ?? null,
  });
  // Spark's full window metadata lives in the nested snapshot representation.
  const sparkWindows = codex.spark_window as Record<string, unknown> | null;
  const sparkWindow = (key: string) => {
    const w = sparkWindows?.[key] as Record<string, unknown> | undefined;
    return {
      used_percent: w?.used_percent ?? null,
      limit_seconds: w?.limit_seconds ?? null,
      reset_at: w?.reset_at ?? null,
    };
  };
  return {
    settings,
    codex: {
      available: engines.includes('codex'),
      status: codex.status ?? 'unavailable',
      fetched_at: codex.fetched_at ?? null,
      limit_reached:
        (spark ? codex.spark_rate_limit_reached : codex.rate_limit_reached) === true ||
        (spark ? codex.spark_rate_allowed : codex.rate_allowed) === false,
      windows: spark
        ? [sparkWindow('primary_window'), sparkWindow('secondary_window')]
        : [window(codex, 'primary'), window(codex, 'secondary')],
    },
    claude: {
      available: engines.includes('claude'),
      status: claude.status ?? 'ok',
      fetched_at: claude.fetched_at ?? null,
      limit_reached: false,
      windows: [window(claude, 'five_hour', 18000), window(claude, 'seven_day', 604800)],
    },
  };
}

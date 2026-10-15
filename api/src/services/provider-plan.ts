/** Display metadata only. Never infer a subscription from quota size or model access. */
export interface ProviderPlan {
  name: string | null;
  source: 'chatgpt_usage' | 'claude_login' | 'grok_settings';
  observed_at: string | null;
  stale: boolean;
}

export function providerPlan(
  name: string | null,
  source: ProviderPlan['source'],
  observedAt: string | null | undefined,
  failed = false,
): ProviderPlan {
  const observed = observedAt && Number.isFinite(Date.parse(observedAt)) ? observedAt : null;
  return {
    name,
    source,
    observed_at: observed,
    stale: !name || !observed || failed || Date.now() - Date.parse(observed) > 600_000,
  };
}

export function chatGptPlanName(value: unknown): string | null {
  const names: Record<string, string> = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
  };
  return typeof value === 'string' && Object.hasOwn(names, value) ? names[value]! : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Native Claude metadata is reported at login/refresh, not a live billing probe. */
export function claudePlanName(auth: unknown): string | null {
  const oauth = record(record(auth)?.claudeAiOauth);
  const type = oauth?.subscriptionType;
  if (type === 'max') {
    if (oauth?.rateLimitTier === 'default_claude_max_5x') return 'Max 5×';
    if (oauth?.rateLimitTier === 'default_claude_max_20x') return 'Max 20×';
    return 'Max';
  }
  const names: Record<string, string> = { free: 'Free', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };
  return typeof type === 'string' && Object.hasOwn(names, type) ? names[type]! : null;
}

/** Official Grok Build RemoteSettings fields from GET /v1/settings (snake_case). */
export function grokPlanName(body: unknown): string | null {
  const settings = record(body);
  const display = settings?.subscription_tier_display;
  if (
    typeof display === 'string' &&
    display.trim() &&
    display.length <= 128 &&
    !/\p{Cc}/u.test(display)
  )
    return display.trim();
  const tier = settings?.subscription_tier;
  const names: Record<string, string> = {
    free: 'Free',
    premium: 'Premium',
    supergrok: 'SuperGrok',
    supergrok_heavy: 'SuperGrok Heavy',
  };
  return typeof tier === 'string' && Object.hasOwn(names, tier) ? names[tier]! : null;
}

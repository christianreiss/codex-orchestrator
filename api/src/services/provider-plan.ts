/** Display metadata only. Never infer a subscription from quota size or model access. */
export interface ProviderPlan {
  name: string | null;
  source: 'chatgpt_usage' | 'claude_login' | 'grok_settings';
  observed_at: string | null;
  stale: boolean;
}

const POLL_MAX_AGE_MS = 600_000;
/** Native login metadata changes only on a token refresh (roughly every 8 hours while the
 * account is in use), so ten polling minutes would mark every Claude plan "last known". */
const MAX_AGE_MS: Record<ProviderPlan['source'], number> = {
  chatgpt_usage: POLL_MAX_AGE_MS,
  claude_login: 48 * 3_600_000,
  grok_settings: POLL_MAX_AGE_MS,
};

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
    stale: !name || !observed || failed || Date.now() - Date.parse(observed) > MAX_AGE_MS[source],
  };
}

/** Plan identifiers of the Codex CLI's `PlanType` wire enum (verified against codex 0.167.2). */
const CHATGPT_PLANS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  promax: 'Pro Max',
  team: 'Team',
  business: 'Business',
  self_serve_business_prolite: 'Business Pro Lite',
  self_serve_business_usage_based: 'Business (usage-based)',
  enterprise: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise (usage-based)',
  enterprise_cbp_automation: 'Enterprise (automation)',
  edu: 'Edu',
  education: 'Edu',
  edu_pro: 'Edu Pro',
};

/**
 * Known slugs get their curated label. A new provider-reported slug is shown humanised
 * rather than blank: it is the provider's own plan identifier, never an inference.
 */
export function chatGptPlanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (Object.hasOwn(CHATGPT_PLANS, value)) return CHATGPT_PLANS[value]!;
  if (value === 'unknown' || !/^[a-z][a-z0-9_]{1,39}$/.test(value)) return null;
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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

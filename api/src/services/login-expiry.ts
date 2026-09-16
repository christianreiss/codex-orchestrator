import type { CredentialIdentity } from './auth-generation.js';

export interface LoginExpiry {
  state: 'unknown' | 'ok' | 'expiring' | 'expired' | 'not_applicable';
  expires_at: string | null;
  days_remaining: number | null;
}

const DAY = 86_400_000;
const WARNING_WINDOW = 3 * DAY;

/** Advisory only: expiry never changes runner verification or launch eligibility. */
export function assessLoginExpiry(identity: CredentialIdentity | null, now = Date.now()): LoginExpiry {
  const empty = { expires_at: null, days_remaining: null };
  if (!identity) return { state: 'unknown', ...empty };
  if (identity.kind !== 'claude_oauth') return { state: 'not_applicable', ...empty };
  const expiry = identity.refreshExpiresAt ? Date.parse(identity.refreshExpiresAt) : NaN;
  if (!Number.isFinite(expiry)) return { state: 'unknown', ...empty };
  const remaining = expiry - now;
  const accessExpiry = identity.accessExpiresAt ? Date.parse(identity.accessExpiresAt) : NaN;
  // Match Claude Code's suppression for long-lived access credentials.
  const suppressed = accessExpiry > expiry + WARNING_WINDOW;
  return {
    state: suppressed ? 'not_applicable' : remaining <= 0 ? 'expired' : remaining <= WARNING_WINDOW ? 'expiring' : 'ok',
    expires_at: new Date(expiry).toISOString(),
    days_remaining: Math.max(0, Math.ceil(remaining / DAY)),
  };
}

import { describe, expect, it } from 'vitest';
import {
  chatGptPlanName,
  claudePlanName,
  grokPlanName,
  providerPlan,
} from '../../../src/services/provider-plan.js';

describe('provider plan display metadata', () => {
  it('uses only explicit known ChatGPT plans', () => {
    expect(chatGptPlanName('pro')).toBe('Pro');
    expect(chatGptPlanName('business')).toBe('Business');
    for (const value of [null, {}, '', 'future-plan', 'constructor', '__proto__'])
      expect(chatGptPlanName(value)).toBeNull();
  });
  it('distinguishes Claude Max tiers without treating a Team limit as Max', () => {
    const auth = (subscriptionType: string, rateLimitTier?: string) => ({
      claudeAiOauth: { subscriptionType, rateLimitTier, accessToken: 'never-display' },
    });
    expect(claudePlanName(auth('max', 'default_claude_max_5x'))).toBe('Max 5×');
    expect(claudePlanName(auth('max', 'default_claude_max_20x'))).toBe('Max 20×');
    expect(claudePlanName(auth('max', 'unknown'))).toBe('Max');
    expect(claudePlanName(auth('team', 'default_claude_max_5x'))).toBe('Team');
    expect(claudePlanName(auth('pro'))).toBe('Pro');
    expect(claudePlanName(auth('constructor'))).toBeNull();
    expect(claudePlanName({})).toBeNull();
    expect(claudePlanName({ claudeAiOauth: { rateLimitTier: 'default_claude_max_20x' } })).toBeNull();
  });
  it('prefers the Grok provider display name and never infers a plan from usage', () => {
    expect(
      grokPlanName({ subscription_tier_display: 'SuperGrok Heavy', subscription_tier: 'supergrok' }),
    ).toBe('SuperGrok Heavy');
    expect(grokPlanName({ subscription_tier: 'supergrok' })).toBe('SuperGrok');
    expect(grokPlanName({ subscriptionTier: 5, config: { monthlyLimit: { val: 30000 } } })).toBeNull();
    for (const value of [null, {}, 'x'.repeat(129), 'bad\nname'])
      expect(grokPlanName({ subscription_tier_display: value })).toBeNull();
  });
  it('marks missing, failed and old observations stale independently of quota', () => {
    const now = new Date().toISOString();
    expect(providerPlan('Pro', 'chatgpt_usage', now).stale).toBe(false);
    expect(providerPlan('Max', 'claude_login', new Date(Date.now() - 601_000).toISOString()).stale).toBe(
      true,
    );
    expect(providerPlan('SuperGrok', 'grok_settings', now, true).stale).toBe(true);
    expect(providerPlan(null, 'grok_settings', now).stale).toBe(true);
    expect(providerPlan('Pro', 'chatgpt_usage', 'bad')).toMatchObject({ observed_at: null, stale: true });
  });
});

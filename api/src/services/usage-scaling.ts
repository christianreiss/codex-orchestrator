/**
 * Host-quota scaling policy. The rules are stored as a JSON blob under the
 * versions table key `usage_scaling_rules`. The legacy PHP UsageScalingService
 * computes a "current status" snapshot that the dashboard renders; we preserve
 * the shape but defer side-effects (forcing hosts to a lane) to the
 * host-runner pipeline.
 */

import { SettingsService } from './settings.js';

export interface ScalingTier {
  at_percent: number;
  lane?: 'normal' | 'spark';
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  model?: string | null;
}

export interface ScalingRules {
  enabled: boolean;
  tiers: ScalingTier[];
}

export interface ScalingStatus {
  enabled: boolean;
  rules: ScalingRules | null;
  active_tier: ScalingTier | null;
}

const KEY = 'usage_scaling_rules';

export class UsageScalingService {
  constructor(private readonly settings: SettingsService) {}

  async currentStatus(currentPercent?: number | null): Promise<ScalingStatus> {
    const rules = await this.loadRules();
    if (!rules || !rules.enabled) {
      return { enabled: false, rules: rules ?? null, active_tier: null };
    }
    let active: ScalingTier | null = null;
    if (typeof currentPercent === 'number') {
      for (const tier of rules.tiers) {
        if (currentPercent >= tier.at_percent) {
          active = tier;
        }
      }
    }
    return { enabled: true, rules, active_tier: active };
  }

  async storeRules(input: unknown): Promise<string[]> {
    const errors: string[] = [];
    if (!input || typeof input !== 'object') {
      errors.push('payload must be an object');
      return errors;
    }
    const obj = input as Record<string, unknown>;
    const enabled = obj.enabled === undefined ? false : Boolean(obj.enabled);
    const tiersRaw = obj.tiers ?? [];
    if (!Array.isArray(tiersRaw)) {
      errors.push('tiers must be an array');
      return errors;
    }
    const tiers: ScalingTier[] = [];
    for (let i = 0; i < tiersRaw.length; i++) {
      const t = tiersRaw[i];
      if (!t || typeof t !== 'object') {
        errors.push(`tiers[${i}] must be an object`);
        continue;
      }
      const tObj = t as Record<string, unknown>;
      const at = Number(tObj.at_percent);
      if (!Number.isFinite(at) || at < 0 || at > 100) {
        errors.push(`tiers[${i}].at_percent must be 0..100`);
        continue;
      }
      const tier: ScalingTier = { at_percent: at };
      if (tObj.lane === 'normal' || tObj.lane === 'spark') tier.lane = tObj.lane;
      if (
        tObj.reasoning_effort === 'minimal' ||
        tObj.reasoning_effort === 'low' ||
        tObj.reasoning_effort === 'medium' ||
        tObj.reasoning_effort === 'high'
      ) {
        tier.reasoning_effort = tObj.reasoning_effort;
      }
      if (typeof tObj.model === 'string' || tObj.model === null) {
        tier.model = (tObj.model as string | null) ?? null;
      }
      tiers.push(tier);
    }
    if (errors.length) return errors;
    tiers.sort((a, b) => a.at_percent - b.at_percent);
    await this.settings.set(KEY, JSON.stringify({ enabled, tiers } satisfies ScalingRules));
    return [];
  }

  async loadRules(): Promise<ScalingRules | null> {
    const raw = await this.settings.getRaw(KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ScalingRules;
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        enabled: Boolean(parsed.enabled),
        tiers: Array.isArray(parsed.tiers) ? parsed.tiers : [],
      };
    } catch {
      return null;
    }
  }
}

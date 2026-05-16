import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageScalingService } from '../../../src/services/usage-scaling.js';

class FakeSettings {
  private store = new Map<string, string>();
  async getRaw(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

describe('UsageScalingService', () => {
  let settings: FakeSettings;
  let service: UsageScalingService;

  beforeEach(() => {
    settings = new FakeSettings();
    // The class accepts SettingsService but we duck-type here with a fake.
    service = new UsageScalingService(settings as unknown as import('../../../src/services/settings.js').SettingsService);
  });

  it('returns disabled status when no rules stored', async () => {
    const status = await service.currentStatus();
    expect(status.enabled).toBe(false);
    expect(status.active_tier).toBeNull();
  });

  it('validates payload shape', async () => {
    expect(await service.storeRules(null)).toContain('payload must be an object');
    expect(await service.storeRules({ tiers: 'nope' })).toContain('tiers must be an array');
  });

  it('rejects out-of-range at_percent', async () => {
    const errs = await service.storeRules({ enabled: true, tiers: [{ at_percent: 150 }] });
    expect(errs.some((e) => e.includes('at_percent'))).toBe(true);
  });

  it('stores and reads back valid rules sorted ascending', async () => {
    const errs = await service.storeRules({
      enabled: true,
      tiers: [
        { at_percent: 90, lane: 'spark' },
        { at_percent: 75, reasoning_effort: 'low' },
        { at_percent: 50 },
      ],
    });
    expect(errs).toEqual([]);
    const rules = await service.loadRules();
    expect(rules?.enabled).toBe(true);
    expect(rules?.tiers.map((t) => t.at_percent)).toEqual([50, 75, 90]);
  });

  it('picks the highest matching tier', async () => {
    await service.storeRules({
      enabled: true,
      tiers: [
        { at_percent: 50, lane: 'spark' },
        { at_percent: 80, lane: 'normal' },
      ],
    });
    const status = await service.currentStatus(85);
    expect(status.active_tier?.at_percent).toBe(80);
    const status70 = await service.currentStatus(70);
    expect(status70.active_tier?.at_percent).toBe(50);
    const status40 = await service.currentStatus(40);
    expect(status40.active_tier).toBeNull();
  });
});

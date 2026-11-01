import { describe, expect, it } from 'vitest';
import {
  advanceEmulation,
  emulationObservation,
  emulatedWindow,
  emulationBlocks,
  DEFAULT_EMULATION,
  parseEmulation,
  assertEmulationAdmission,
} from '../../../src/services/quota-emulation.js';
import { quotaSnapshot, quotaInterruption } from '../../../src/services/quota-observation.js';
import { OwnerStateSnapshot } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { randomUUID } from 'node:crypto';
import { createDbFake } from '../../helpers/db-fake.js';
import {
  providerAccounts,
  versions,
  chatgptUsageSnapshots,
  quotaEmulationStates,
} from '../../../src/db/schema.js';
import { DEFAULT_QUOTA_POLICY } from '../../../src/services/quota-policy.js';

const now = Date.parse('2026-11-01T12:00:00Z');
const iso = (hours = 0) => new Date(now + hours * 3600000).toISOString();
const settings = { ...DEFAULT_EMULATION, enabled: true };
const observation = (used: number, hours = 0) => ({
  accountId: 1,
  observedAt: iso(hours),
  weeklyUsed: used,
  periodResetAt: iso(100),
  nativeShort: false,
});
const base = () => advanceEmulation(null, observation(20), 'codex', settings)!;

describe('emulated account budgets', () => {
  it.each([5, 8] as const)(
    'budgets %ih as a fraction of 168h and includes the first consumed delta',
    (hours) => {
      const config = { ...settings, window_hours: hours };
      let row = advanceEmulation(null, observation(20), 'codex', config)!;
      expect(row.startedAt).toBeNull();
      row = advanceEmulation(row, observation(20 + (100 * hours) / 168, 1), 'codex', config)!;
      const w = emulatedWindow(row, config, observation(row.lastUsedPercent, 1), now + 3600000)!;
      expect(w.used_percent).toBeCloseTo(100);
      expect(w.resets_at).toBe(iso(1 + hours));
      expect(w.budget_weekly_percent).toBeCloseTo((100 * hours) / 168);
      expect(emulationBlocks({ ...w, action: 'hard_stop' })).toBe(true);
    },
  );
  it('counts account-wide observations once, rejecting duplicates and reverse arrival order', () => {
    const row = advanceEmulation(base(), observation(21, 1), 'codex', settings)!;
    expect(advanceEmulation(row, observation(21, 1), 'codex', settings)).toBe(row);
    expect(advanceEmulation(row, observation(22, 0.5), 'codex', settings)).toBe(row);
    expect(advanceEmulation(row, observation(22, 2), 'codex', settings)?.consumedPercent).toBe(2);
  });
  it('persists a fixed expiry; duration edits affect only the next window', () => {
    let row = advanceEmulation(base(), observation(21, 1), 'codex', settings)!;
    row = advanceEmulation(structuredClone(row), observation(22, 2), 'codex', {
      ...settings,
      window_hours: 8,
    })!;
    expect(row.resetsAt).toBe(iso(6));
    const expired = emulatedWindow(row, settings, observation(22, 6), now + 6 * 3600000)!;
    expect(expired.used_percent).toBe(0);
    expect(expired.resets_at).toBeNull();
    row = advanceEmulation(row, observation(23, 6), 'codex', { ...settings, window_hours: 8 })!;
    expect(row.resetsAt).toBe(iso(14));
    expect(row.consumedPercent).toBe(1);
  });
  it('ends at the provider weekly reset and never subtracts a new period from an old baseline', () => {
    const shortPeriod = { ...observation(21, 1), periodResetAt: iso(2) };
    const prior = advanceEmulation(null, { ...observation(20), periodResetAt: iso(2) }, 'codex', settings)!;
    const active = advanceEmulation(prior, shortPeriod, 'codex', settings)!;
    expect(active.resetsAt).toBe(iso(2));
    const reset = advanceEmulation(
      active,
      { ...observation(1, 2), periodResetAt: iso(170) },
      'codex',
      settings,
    )!;
    expect(reset.consumedPercent).toBe(0);
    expect(reset.startedAt).toBeNull();
  });
  it('invalidates unexplained corrections until the next provider period', () => {
    const invalid = advanceEmulation(base(), observation(19, 1), 'codex', settings)!;
    expect(invalid.valid).toBe(0);
    expect(emulatedWindow(invalid, settings, observation(19, 1), now + 3600000)).toBeNull();
    expect(advanceEmulation(invalid, observation(25, 2), 'codex', settings)?.valid).toBe(0);
  });
  it.each(['suggest_pause', 'suggest_ignore', 'hard_stop'] as const)(
    'enforces only hard stop, with fresh data (%s)',
    (action) => {
      const row = advanceEmulation(base(), observation(24, 1), 'codex', settings)!;
      const config = { ...settings, action };
      const w = emulatedWindow(row, config, observation(24, 1), now + 3600000)!;
      expect(emulationBlocks(w)).toBe(action === 'hard_stop');
      expect(emulationBlocks(emulatedWindow(row, config, observation(24, 1), now + 2 * 3600000))).toBe(false);
      expect(emulatedWindow(row, config, null, now)).toBeNull();
    },
  );
  it('retains real zero native windows and classifies Codex slots by duration', () => {
    const o = emulationObservation('codex', {
      accountId: 1,
      fetchedAt: iso(),
      status: 'ok',
      primaryUsedPercent: 20,
      primaryLimitSeconds: 604800,
      primaryResetAt: iso(100),
      secondaryUsedPercent: 0,
      secondaryLimitSeconds: 18000,
    });
    expect(o?.nativeShort).toBe(true);
    expect(advanceEmulation(base(), o!, 'codex', settings)).toBeNull();
    expect(
      emulationObservation('codex', {
        accountId: 1,
        fetchedAt: iso(),
        status: 'error',
        primaryUsedPercent: 20,
        primaryLimitSeconds: 604800,
        primaryResetAt: iso(100),
      }),
    ).toBeNull();
  });
  it('accepts Claude weekly-only and Grok weekly observations, never monthly or errors', () => {
    const common = { accountId: 1, fetchedAt: iso() };
    expect(
      emulationObservation('claude', { ...common, sevenDayUsedPercent: 0, sevenDayResetsAt: iso(100) })
        ?.nativeShort,
    ).toBe(false);
    expect(
      emulationObservation('grok', {
        ...common,
        periodType: 'weekly',
        usedPercent: 0,
        periodResetsAt: iso(100),
      })?.weeklyUsed,
    ).toBe(0);
    expect(
      emulationObservation('grok', {
        ...common,
        periodType: 'monthly',
        usedPercent: 0,
        periodResetsAt: iso(100),
      }),
    ).toBeNull();
    expect(
      emulationObservation('grok', {
        ...common,
        periodType: 'weekly',
        usedPercent: 0,
        periodResetsAt: iso(100),
        errorCode: 'outage',
      }),
    ).toBeNull();
  });
  it('defaults to off and fails safely on invalid settings', () => {
    expect(parseEmulation(null)).toEqual(DEFAULT_EMULATION);
    expect(parseEmulation('{')).toEqual(DEFAULT_EMULATION);
    expect(advanceEmulation(base(), observation(24, 1), 'codex', DEFAULT_EMULATION)).toBeNull();
  });
  it('exposes synthetic usage without arming provider interruption recovery', async () => {
    const db = createDbFake();
    const row = advanceEmulation(base(), observation(24, 1), 'codex', settings)!;
    db.tables.set(providerAccounts, [{ id: 1, engine: 'codex', label: 'One', state: 'enabled' }]);
    db.tables.set(versions, [
      { name: 'quota_emulation_codex', version: JSON.stringify({ ...settings, action: 'hard_stop' }) },
    ]);
    db.tables.set(quotaEmulationStates, [row]);
    db.tables.set(chatgptUsageSnapshots, [
      {
        id: 1,
        accountId: 1,
        fetchedAt: iso(1),
        status: 'ok',
        primaryUsedPercent: 24,
        primaryLimitSeconds: 604800,
        primaryResetAt: iso(100),
      },
    ]);
    const q = await quotaSnapshot(db as never, 1, 'codex', now + 3600000);
    expect(q?.short).toMatchObject({ source: 'emulated', action: 'hard_stop', status: 'fresh' });
    expect(quotaInterruption(q, true, undefined, now + 3600000)).toBeNull();
    db.tables
      .get(versions)!
      .push({
        name: 'quota_policy_account_1',
        version: JSON.stringify({ ...DEFAULT_QUOTA_POLICY, unlimited: true }),
      });
    expect((await quotaSnapshot(db as never, 1, 'codex', now + 3600000))?.short).toBeNull();
  });
  it('uses the selected account only, and does not bypass admission for VIP hosts', () => {
    const realNow = Date.now(),
      fetchedAt = new Date(realNow).toISOString(),
      reset = new Date(realNow + 3600000).toISOString();
    const s = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      versions: [
        { name: 'quota_emulation_codex', version: JSON.stringify({ ...settings, action: 'hard_stop' }) },
      ],
      hosts: [{ id: 1, vip: 1 }],
      chatgptUsageSnapshots: [
        {
          id: 1,
          accountId: 1,
          status: 'ok',
          fetchedAt,
          primaryUsedPercent: 24,
          primaryLimitSeconds: 604800,
          primaryResetAt: reset,
        },
      ],
      quotaEmulationStates: [
        {
          ...base(),
          observedAt: fetchedAt,
          periodResetAt: reset,
          startedAt: fetchedAt,
          resetsAt: reset,
          consumedPercent: 4,
        },
      ],
    } as unknown as StateSeed);
    expect(() => assertEmulationAdmission(s, 'codex', 1)).toThrow('Emulated short quota exhausted');
    expect(() => assertEmulationAdmission(s, 'codex', 2)).not.toThrow();
  });
});

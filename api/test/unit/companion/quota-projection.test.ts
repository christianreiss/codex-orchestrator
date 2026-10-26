import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../../src/routes/index.js';
import { companionQuotas } from '../../../src/services/companion/quotas.js';
vi.mock('../../../src/control-plane/state/runtime.js', () => ({ ownerRuntimeFor: () => null }));
vi.mock('../../../src/services/engine-switch.js', () => ({
  readFleetEngineState: async () => ({ codex: true, claude: true, grok: false }),
}));
vi.mock('../../../src/services/provider-accounts.js', () => ({
  ProviderAccountsService: class {
    async usage(_id: number, engine: string) {
      return {
        fetched_at: '2026-10-26T08:00:00Z',
        stale: false,
        secret: 'never disclose',
        short_used_percent: engine === 'claude' ? 12 : null,
        short_resets_at: null,
        short_limit_seconds: 18000,
        weekly_used_percent: engine === 'codex' ? 0 : null,
        weekly_resets_at: null,
        weekly_limit_seconds: 604800,
        ...(engine === 'grok'
          ? { current_window: { used_percent: 42, period: 'monthly', resets_at: '2026-11-01T00:00:00Z' } }
          : {}),
      };
    }
  },
}));

describe('companion quota projection', () => {
  it('keeps zero usage and provider window meanings, excludes removed accounts and private metadata', async () => {
    const rows = ['codex', 'claude', 'grok'].map((engine, index) => ({
      id: index + 1,
      engine,
      label: engine,
      state: 'enabled',
      credential: 'never disclose',
    }));
    rows.push({ id: 4, engine: 'codex', label: 'Removed', state: 'removed', credential: 'never disclose' });
    const ctx = {
      db: { select: () => ({ from: () => ({ orderBy: async () => rows }) }) },
      keyring: {},
    } as unknown as RouteContext;
    const result = await companionQuotas(ctx);
    expect(result.engines.map((e) => e.engine)).toEqual(['codex', 'claude', 'grok']);
    expect(result.engines[0]!.accounts).toHaveLength(1);
    expect(result.engines[0]!.accounts[0]!.windows).toEqual([
      { kind: 'weekly', used_percent: 0, resets_at: null, limit_seconds: 604800 },
    ]);
    expect(result.engines[1]!.accounts[0]!.windows[0]).toMatchObject({
      kind: 'short',
      used_percent: 12,
      limit_seconds: 18000,
    });
    expect(result.engines[2]!).toMatchObject({
      enabled: false,
      accounts: [{ windows: [{ kind: 'monthly', used_percent: 42 }] }],
    });
    expect(JSON.stringify(result)).not.toContain('never disclose');
  });
});

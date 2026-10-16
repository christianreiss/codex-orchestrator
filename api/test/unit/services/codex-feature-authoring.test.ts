import { describe, expect, it } from 'vitest';
import { ClientConfigService, renderToml } from '../../../src/services/client-config.js';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const invalidFeatures = [
  { nonsense: 'invalid' }, { nonsense: null }, { async_compaction: 'invalid' },
  { hooks: 'true' }, { hooks: 1 }, { hooks: [] },
  { async_compaction: { enabled: 'true' } },
  { async_compaction: { model_async_compact_threshold_percent: 101 } },
  { async_compaction: { model_async_compact_threshold_percent: 0 } },
  { async_compaction: { model_async_compact_threshold_percent: 3.5 } },
  { async_compaction: { model: 'unexpected' } },
  { async_compaction: { enabled: null } },
  { multi_agent_v2: { preserve_fork_prefix: 'yes' } },
  { rollout_budget: { limit_tokens: 'many' } },
  { transcript_v2: true }, { use_legacy_landlock: null },
  { guardianv2: { thread_context: true } }, { 'guardianv2.thread_context': false },
  { codex_hooks: 'true' }, { web_search_request: 'true' },
  [], 'invalid',
];

describe('Codex structured feature authoring', () => {
  for (const scope of ['root', 'profile'] as const) {
    it.each(invalidFeatures)(`rejects invalid ${scope} features before preview or persistence: %j`, async features => {
      const db = createDbFake();
      const service = new ClientConfigService(db as never);
      const settings = scope === 'root' ? { features } : { profiles: [{ name: 'audit', features }] };
      const path = scope === 'root' ? /settings.features/ : /settings.profiles\[0\].features/;
      expect(() => service.render(settings)).toThrow(path);
      await expect(service.store({ settings })).rejects.toThrow(path);
      expect(db.tables.get(clientConfigDocuments) ?? []).toHaveLength(0);
    });
  }

  it('checks the legacy final renderer even without native_settings', () => {
    expect(() => renderToml(normalizeSettings({ features: { nonsense: null } }))).toThrow(/features.nonsense/);
    expect(() => renderToml(normalizeSettings({ features: { async_compaction: { enabled: 'invalid' } } }))).toThrow();
    expect(() => renderToml(normalizeSettings({ profiles: [{ name: 'audit', features: { nonsense: null } }] }))).toThrow();
  });

  it('roundtrips supported boolean and structured values, changes and removals', async () => {
    const db = createDbFake();
    const service = new ClientConfigService(db as never);
    const features = { hooks: false, async_compaction: { enabled: true, model_async_compact_threshold_percent: 70 },
      multi_agent_v2: { disable_native_tools: true, preserve_fork_prefix: false } };
    const first = await service.store({ settings: { features, profiles: [{ name: 'audit', features }] } });
    const fetched = await service.adminFetch();
    expect(fetched.settings?.features).toEqual(features);
    expect(fetched.settings?.profiles[0]?.features).toEqual(features);
    expect(service.render(fetched.settings).content).toBe(first.content);
    const changed = await service.store({ settings: { features: { async_compaction: false }, profiles: [{ name: 'audit', features: {} }] }, expected_revision: fetched.revision });
    expect(changed.content).toContain('async_compaction = false');
    expect(changed.content).not.toContain('hooks =');
    expect(service.render(changed.settings).profiles?.[0]?.content).not.toContain('async_compaction');
    // The minimal DB fake ignores ORDER BY; present the newest row first.
    db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
    const removed = await service.store({ settings: { features: null, profiles: [] }, expected_revision: changed.revision });
    expect(removed.content).not.toContain('[features]');
  });

  it('validates partial structured overlays after merging native values', () => {
    const service = new ClientConfigService({} as never);
    const native_settings = { features: { rollout_budget: { limit_tokens: 1000, reminder_at_remaining_tokens: [100] }, hooks: true } };
    const features = { rollout_budget: { enabled: true }, hooks: false };
    expect(service.render({ native_settings, features, profiles: [{ name: 'audit', native_settings, features }] }).content).toContain('hooks = false');
    expect(() => service.render({ features })).toThrow(/rollout_budget.limit_tokens/);
  });

  it('documents null as withdrawal of a structured override, preserving native fallback', () => {
    const service = new ClientConfigService({} as never);
    expect(service.render({ features: { hooks: null, async_compaction: null } }).content).not.toMatch(/hooks =|async_compaction =/);
    expect(service.render({ native_settings: { features: { hooks: true } }, features: { hooks: null } }).content).toContain('hooks = true');
    for (const native_settings of [null, {}]) {
      expect(service.render({ native_settings, features: { hooks: false } }).content).toContain('hooks = false');
    }
    expect(() => service.render({ native_settings: { features: { hooks: null } } })).toThrow(/TOML has no null/);
  });

  it('preserves explicit legacy read migrations while rejecting new inert controls', async () => {
    const db = createDbFake();
    db.tables.set(clientConfigDocuments, [{ id: 1, engine: 'codex', body: 'historical', sha256: 'a'.repeat(64), updatedAt: '2026-10-16T00:00:00Z',
      settings: { features: { hooks: 'true', transcript_v2: true }, profiles: [{ name: 'audit', features: { hooks: 'false', steer: true } }] } }]);
    const service = new ClientConfigService(db as never);
    const fetched = await service.adminFetch();
    expect(fetched.settings?.features).toEqual({ hooks: true });
    expect(fetched.settings?.profiles[0]?.features).toEqual({ hooks: false });
    await expect(service.store({ settings: fetched.settings, expected_revision: fetched.revision })).resolves.toMatchObject({ status: 'ok' });
    expect(() => service.render({ features: { transcript_v2: true } })).toThrow(/removed or deprecated/);
    expect(service.render({ features: { codex_hooks: true, web_search_request: true } }).content).toMatch(/hooks = true/);
    expect(service.render({ features: { codex_hooks: true, web_search_request: true } }).content).toMatch(/web_search = "live"/);
  });

  it.each([
    [{ web_search_request: true }, 'live'], [{ web_search_cached: true }, 'cached'],
    [{ web_search: true }, 'live'], [{ web_search: false }, 'disabled'],
    [{ web_search_request: false, web_search_cached: false }, 'disabled'],
    [{ web_search_request: false, web_search_cached: true }, 'cached'],
  ])('migrates legacy web-search aliases at root and profile without losing the selection: %j', (features, value) => {
    const service = new ClientConfigService({} as never);
    const result = service.render({ features, profiles: [{ name: 'audit', features }] });
    expect(result.settings.web_search).toBe(value);
    expect(result.settings.profiles[0]?.web_search).toBe(value);
    expect(result.content).toContain(`web_search = "${value}"`);
    expect(result.profiles?.[0]?.content).toContain(`web_search = "${value}"`);
  });

  it('migrates false hook aliases in root and profile without enabling hooks', () => {
    const result = new ClientConfigService({} as never).render({ features: { codex_hooks: false }, profiles: [{ name: 'audit', features: { codex_hooks: false } }] });
    expect(result.settings.features).toEqual({ hooks: false });
    expect(result.settings.profiles[0]?.features).toEqual({ hooks: false });
    expect(result.content).toContain('hooks = false');
    expect(result.profiles?.[0]?.content).toContain('hooks = false');
  });

  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('loads structured root and profile output with the native parser', () => {
    const features = { hooks: false, async_compaction: { enabled: true, model_async_compact_threshold_percent: 70 },
      multi_agent_v2: { preserve_fork_prefix: false, disable_native_tools: true } };
    const rendered = new ClientConfigService({} as never).render({ features, profiles: [{ name: 'audit', features }] });
    const home = mkdtempSync(join(tmpdir(), 'codex-structured-features-'));
    try {
      // features list has no --profile support. Parse each emitted layer as
      // config.toml to verify its TOML/types without opening a native session.
      for (const content of [rendered.content, rendered.profiles![0]!.content]) {
        writeFileSync(join(home, 'config.toml'), content);
        const result = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 15000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

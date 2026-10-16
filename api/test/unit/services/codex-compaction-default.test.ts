import { describe, expect, it } from 'vitest';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('Codex fleet async compaction default', () => {
  const service = () => new ClientConfigService(createDbFake() as never);
  const host = (version: string | null, settings: unknown = {}) => renderTomlForHost({
    settings, host: { clientVersion: version } as never, baseUrl: null, apiKey: null,
  });
  it('enables missing and withdrawn values in previews without mutating saved input', () => {
    for (const input of [{}, { native_settings: {} }, { features: { async_compaction: null } }]) {
      const before = structuredClone(input);
      expect(service().render(input).content).toContain('async_compaction = true');
      expect(input).toEqual(before);
    }
  });
  it.each([false, { enabled: false }, { model_async_compact_threshold_percent: 70 }])('preserves explicit native semantics: %j', value => {
    for (const input of [{ features: { async_compaction: value } }, { native_settings: { features: { async_compaction: value } } }]) {
      const rendered = service().render(input).content;
      expect(rendered).not.toContain('async_compaction = true');
      expect(rendered).not.toContain('enabled = true');
    }
  });
  it('keeps the implicit default off old and unreported clients without blocking sync', () => {
    for (const version of ['0.162.1', '0.156.1', '0.163.0-alpha.1', null]) expect(host(version).content).not.toContain('async_compaction');
    for (const version of ['0.163.0', 'codex-cli 0.164.0']) expect(host(version).content).toContain('async_compaction = true');
    expect(() => host('0.162.1', { native_settings: { features: { async_compaction: false } } })).toThrow(/0\.163\.0/);
  });
  it('leaves profile sidecars inheriting and respects an explicit profile opt-out', () => {
    const result = host('0.163.0', { profiles: [{ name: 'inherit', native_settings: { service_tier: 'priority' } },
      { name: 'off', native_settings: { features: { async_compaction: false } } }] });
    expect(result.content).toContain('async_compaction = true');
    expect(result.profiles?.find(p => p.name === 'inherit')?.content).not.toContain('async_compaction');
    expect(result.profiles?.find(p => p.name === 'off')?.content).toContain('async_compaction = false');
  });
  it('roundtrips an explicit opt-out and resets to the default when removed', async () => {
    const s = service();
    const saved = await s.store({ settings: { native_settings: { features: { async_compaction: { enabled: false, model_async_compact_threshold_percent: 71 } } } } });
    const fetched = await s.adminFetch();
    expect(s.render(fetched.settings).content).toBe(saved.content);
    expect(saved.content).toContain('enabled = false');
    expect(saved.content).toContain('model_async_compact_threshold_percent = 71');
    expect(s.render({ native_settings: { features: {} } }).content).toContain('async_compaction = true');
  });
  it('does not add a Codex feature to other engines', () => {
    for (const engine of ['claude', 'grok'] as const) expect(service().render({}, engine).content).not.toContain('async_compaction');
  });
  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('the actual native feature resolver reports the default on and explicit opt-out off', () => {
    const home = mkdtempSync(join(tmpdir(), 'ava-compaction-native-'));
    try {
      for (const enabled of [true, false]) {
        writeFileSync(join(home, 'config.toml'), service().render(enabled ? {} : {
          native_settings: { features: { async_compaction: { enabled: false, model_async_compact_threshold_percent: 71 } } },
        }).content);
        const result = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], {
          env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 15000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toMatch(new RegExp(`async_compaction\\s+under development\\s+${enabled}`));
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

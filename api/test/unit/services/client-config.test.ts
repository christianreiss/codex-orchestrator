import { describe, expect, it } from 'vitest';
import { renderToml } from '../../../src/services/client-config.js';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';

describe('client-config: renderToml', () => {
  it('renders root scalars in the legacy order', () => {
    const s = normalizeSettings({
      model: 'gpt-5.4',
      profile: 'workhorse',
      personality: 'friendly',
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
      model_reasoning_effort: 'high',
    });
    const toml = renderToml(s);
    const lines = toml.split('\n');
    expect(lines[0]).toBe('model = "gpt-5.4"');
    expect(toml).toContain('profile = "workhorse"');
    expect(toml).toContain('personality = "friendly"');
    expect(toml).toContain('approval_policy = "on-request"');
    expect(toml).toContain('sandbox_mode = "workspace-write"');
    expect(toml).toContain('model_reasoning_effort = "high"');
  });

  it('emits a [features] section sorted alphabetically', () => {
    const s = normalizeSettings({
      features: { zebra: true, apple: false, mango: true },
    });
    const toml = renderToml(s);
    const featuresIdx = toml.indexOf('[features]');
    expect(featuresIdx).toBeGreaterThan(-1);
    const after = toml.slice(featuresIdx);
    const appleIdx = after.indexOf('apple');
    const mangoIdx = after.indexOf('mango');
    const zebraIdx = after.indexOf('zebra');
    expect(appleIdx).toBeLessThan(mangoIdx);
    expect(mangoIdx).toBeLessThan(zebraIdx);
  });

  it('emits [security] only when bypass flag is explicitly set', () => {
    const off = renderToml(normalizeSettings({ security: { dangerously_bypass_approvals_and_sandbox: false } }));
    expect(off).toContain('[security]');
    expect(off).toContain('dangerously_bypass_approvals_and_sandbox = false');
    const none = renderToml(normalizeSettings({}));
    expect(none).not.toContain('[security]');
  });

  it('emits [[profiles]] entries in declared order', () => {
    const s = normalizeSettings({
      profiles: [
        { name: 'workhorse', model: 'gpt-5.4', model_reasoning_effort: 'high' },
        { name: 'fast', model: 'gpt-5.4-mini' },
      ],
    });
    const toml = renderToml(s);
    expect(toml.match(/\[\[profiles\]\]/g)?.length).toBe(2);
    const workhorseIdx = toml.indexOf('"workhorse"');
    const fastIdx = toml.indexOf('"fast"');
    expect(workhorseIdx).toBeGreaterThan(-1);
    expect(fastIdx).toBeGreaterThan(workhorseIdx);
  });

  it('renders notify lists when present', () => {
    const s = normalizeSettings({ notify: ['mailto:a@b', 'webhook'] });
    const toml = renderToml(s);
    expect(toml).toContain('notify = ["mailto:a@b", "webhook"]');
  });

  it('escapes strings with quotes and newlines', () => {
    const s = normalizeSettings({ model: 'has "quotes" and\nnewline' });
    const toml = renderToml(s);
    expect(toml).toContain('model = "has \\"quotes\\" and\\nnewline"');
  });
});

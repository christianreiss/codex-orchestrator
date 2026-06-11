import { afterEach, describe, it, expect, vi } from 'vitest';
import { ClientVersionsService, isSemanticVersion, normalizeVersion } from '../../../src/services/client-versions.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('client-versions helpers', () => {
  it('accepts dotted semantic versions', () => {
    expect(isSemanticVersion('0.125.0')).toBe(true);
    expect(isSemanticVersion('1.2.3')).toBe(true);
    expect(isSemanticVersion('1.2.3-rc.1')).toBe(true);
  });

  it('rejects non-semver strings', () => {
    expect(isSemanticVersion('latest')).toBe(false);
    expect(isSemanticVersion('v1.2')).toBe(false);
    expect(isSemanticVersion('1.2')).toBe(false);
  });

  it('normalizes version strings by stripping leading v', () => {
    expect(normalizeVersion('v0.125.0')).toBe('0.125.0');
    expect(normalizeVersion('0.125.0')).toBe('0.125.0');
    expect(normalizeVersion('  v1.0.0  ')).toBe('1.0.0');
    expect(normalizeVersion('rust-v0.137.0')).toBe('0.137.0');
    expect(normalizeVersion('codex-cli 0.130.0')).toBe('0.130.0');
    expect(normalizeVersion(null)).toBeNull();
    expect(normalizeVersion('')).toBeNull();
  });

  it('fetches the current Claude Code release from npm', async () => {
    const settings = {
      getWithMeta: vi.fn().mockResolvedValue({ value: null, updatedAt: null }),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ version: '2.1.173' }),
    } as Response);

    const svc = new ClientVersionsService(settings as never);
    const release = await svc.availableClientVersion(true, 'claude');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest',
      expect.any(Object),
    );
    expect(release?.version).toBe('2.1.173');
    expect(settings.set).toHaveBeenCalledWith(
      'github_release_claude-cli',
      expect.stringContaining('"version":"2.1.173"'),
      { publish: false },
    );
  });

  it('fetches the current OpenAI Codex release repo and normalizes rust tags', async () => {
    const settings = {
      getWithMeta: vi.fn().mockResolvedValue({ value: null, updatedAt: null }),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'rust-v0.137.0',
        name: '0.137.0',
        html_url: 'https://github.com/openai/codex/releases/tag/rust-v0.137.0',
        published_at: '2026-06-04T01:17:20Z',
      }),
    } as Response);

    const svc = new ClientVersionsService(settings as never);
    const release = await svc.availableClientVersion(true, 'codex');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/openai/codex/releases/latest',
      expect.any(Object),
    );
    expect(release?.version).toBe('0.137.0');
    expect(settings.set).toHaveBeenCalledWith(
      'github_release_codex-cli',
      expect.stringContaining('"version":"0.137.0"'),
      { publish: false },
    );
  });
});

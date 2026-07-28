import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  ClientVersionsService,
  CODEX_MIN_CLIENT_VERSION,
  coerceCodexVersionToMinimum,
  isSemanticVersion,
  normalizeVersion,
} from '../../../src/services/client-versions.js';
import { wsPublisher } from '../../../src/ws/publisher.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Timestamp the fake stamps onto every write, so `updatedAt` is assertable. */
const SET_AT = '2026-07-28T12:00:00Z';

type Entry = { value: string; updatedAt: string };

/**
 * Map-backed stand-in for SettingsService. Seed values may carry their own
 * `updatedAt` because the release cache branches read row age, not just value.
 */
function makeSettings(seed: Record<string, string | Entry> = {}) {
  const store = new Map<string, Entry>();
  for (const [key, entry] of Object.entries(seed)) {
    store.set(key, typeof entry === 'string' ? { value: entry, updatedAt: SET_AT } : entry);
  }
  return {
    store,
    getString: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    getFlag: vi.fn(async (key: string, defaultValue = false) => {
      const raw = store.get(key)?.value;
      if (raw === undefined || raw === '') return defaultValue;
      return raw === '1' || raw.toLowerCase() === 'true';
    }),
    getWithMeta: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry ? { value: entry.value, updatedAt: entry.updatedAt } : { value: null, updatedAt: null };
    }),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, { value, updatedAt: SET_AT });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function agedIso(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function cachedRelease(name: string, version: string): Entry {
  return {
    value: JSON.stringify({
      name,
      version,
      url: `https://example.test/${version}`,
      published_at: '2026-06-04T01:17:20Z',
      fetched_at: '2026-06-04T02:00:00Z',
      cached: false,
    }),
    updatedAt: agedIso(60),
  };
}

function okJson(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

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

  it('raises Codex pins below the supported minimum up to the floor', () => {
    expect(CODEX_MIN_CLIENT_VERSION).toBe('0.125.0');
    expect(coerceCodexVersionToMinimum('0.9.0')).toBe('0.125.0');
    expect(coerceCodexVersionToMinimum('0.1.0')).toBe('0.125.0');
    expect(coerceCodexVersionToMinimum('0.124.99')).toBe('0.125.0');
    expect(coerceCodexVersionToMinimum('0.124.0-rc.1')).toBe('0.125.0');
  });

  it('leaves Codex pins at or above the supported minimum unchanged', () => {
    expect(coerceCodexVersionToMinimum('0.125.0')).toBe('0.125.0');
    expect(coerceCodexVersionToMinimum('0.125.0-rc.1')).toBe('0.125.0-rc.1');
    expect(coerceCodexVersionToMinimum('0.137.0')).toBe('0.137.0');
    expect(coerceCodexVersionToMinimum('1.0.0')).toBe('1.0.0');
    expect(coerceCodexVersionToMinimum('0.130.0+build.7')).toBe('0.130.0+build.7');
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

describe('ClientVersionsService.versionSummary', () => {
  it('reads the unsuffixed lock key for Codex', async () => {
    const settings = makeSettings({
      client_version_codex: '0.137.0',
      wrapper_version_codex: '0.6.55',
      client_version_checked_at_codex: '2026-07-28T09:00:00Z',
      client_version_lock: { value: '0.136.0', updatedAt: '2026-07-27T08:00:00Z' },
      client_version_lock_claude: '2.1.173',
    });

    const summary = await new ClientVersionsService(settings as never).versionSummary('codex');

    expect(summary).toEqual({
      client_version: '0.137.0',
      wrapper_version: '0.6.55',
      client_version_checked_at: '2026-07-28T09:00:00Z',
      client_version_lock: '0.136.0',
      client_version_lock_updated_at: '2026-07-27T08:00:00Z',
      client_version_enforce_exact: true,
    });
    expect(settings.getWithMeta).toHaveBeenCalledWith('client_version_lock');
  });

  it('reads the _claude-suffixed lock key for Claude', async () => {
    const settings = makeSettings({
      client_version_claude: '2.1.173',
      wrapper_version_claude: '0.4.2',
      client_version_checked_at_claude: '2026-07-28T09:30:00Z',
      client_version_lock: '0.136.0',
      client_version_lock_claude: { value: '2.1.100', updatedAt: '2026-07-26T08:00:00Z' },
    });

    const summary = await new ClientVersionsService(settings as never).versionSummary('claude');

    expect(summary).toEqual({
      client_version: '2.1.173',
      wrapper_version: '0.4.2',
      client_version_checked_at: '2026-07-28T09:30:00Z',
      client_version_lock: '2.1.100',
      client_version_lock_updated_at: '2026-07-26T08:00:00Z',
      client_version_enforce_exact: true,
    });
    expect(settings.getWithMeta).toHaveBeenCalledWith('client_version_lock_claude');
  });

  it('reports enforce_exact false when nothing is locked', async () => {
    const settings = makeSettings({ client_version_codex: '0.137.0' });

    const summary = await new ClientVersionsService(settings as never).versionSummary();

    expect(summary.client_version_lock).toBeNull();
    expect(summary.client_version_lock_updated_at).toBeNull();
    expect(summary.client_version_enforce_exact).toBe(false);
    expect(summary.wrapper_version).toBeNull();
  });

  it('reports enforce_exact from the flag when no lock is set', async () => {
    const settings = makeSettings({ client_version_enforce_exact_codex: '1' });

    const summary = await new ClientVersionsService(settings as never).versionSummary('codex');

    expect(summary.client_version_lock).toBeNull();
    expect(summary.client_version_enforce_exact).toBe(true);
  });
});

describe('ClientVersionsService.availableClientVersion', () => {
  it('serves the cached release without fetching inside the 1h TTL', async () => {
    const settings = makeSettings({
      'github_release_codex-cli': cachedRelease('codex-cli', '0.137.0'),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected upstream fetch'));

    const release = await new ClientVersionsService(settings as never).availableClientVersion();

    expect(release).toMatchObject({ name: 'codex-cli', version: '0.137.0', cached: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('refetches once the cached release is older than the TTL', async () => {
    const settings = makeSettings({
      'github_release_codex-cli': {
        ...cachedRelease('codex-cli', '0.130.0'),
        updatedAt: agedIso(3601),
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ tag_name: 'rust-v0.137.0' }));

    const release = await new ClientVersionsService(settings as never).availableClientVersion();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(release).toMatchObject({ version: '0.137.0', cached: false });
    expect(settings.set).toHaveBeenCalledWith(
      'github_release_codex-cli',
      expect.stringContaining('"version":"0.137.0"'),
      { publish: false },
    );
  });

  it('bypasses a fresh cache when force is set', async () => {
    const settings = makeSettings({
      'github_release_codex-cli': cachedRelease('codex-cli', '0.130.0'),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ tag_name: 'rust-v0.137.0' }));

    const release = await new ClientVersionsService(settings as never).availableClientVersion(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(release).toMatchObject({ version: '0.137.0', cached: false });
  });

  it('refetches when the cached value is not parseable JSON', async () => {
    const settings = makeSettings({
      'github_release_codex-cli': { value: '{not json', updatedAt: agedIso(60) },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ tag_name: 'rust-v0.137.0' }));

    const release = await new ClientVersionsService(settings as never).availableClientVersion();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(release).toMatchObject({ version: '0.137.0', cached: false });
  });

  it('returns null when an unparseable cache is all that survives a failed fetch', async () => {
    const settings = makeSettings({
      'github_release_codex-cli': { value: '{not json', updatedAt: agedIso(60) },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);

    const release = await new ClientVersionsService(settings as never).availableClientVersion();

    expect(release).toBeNull();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('falls back to the stale cached release when the fetch fails', async () => {
    const settings = makeSettings({
      'github_release_codex-cli': {
        ...cachedRelease('codex-cli', '0.130.0'),
        updatedAt: agedIso(7200),
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);

    const release = await new ClientVersionsService(settings as never).availableClientVersion();

    expect(release).toMatchObject({ version: '0.130.0', cached: true });
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('returns null on a non-ok GitHub response with no cache', async () => {
    const settings = makeSettings();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as Response);

    const release = await new ClientVersionsService(settings as never).availableClientVersion();

    expect(release).toBeNull();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('returns null when the GitHub release carries no semantic version', async () => {
    const settings = makeSettings();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ tag_name: 'latest' }));

    const release = await new ClientVersionsService(settings as never).availableClientVersion();

    expect(release).toBeNull();
  });

  it('returns null and warns when the GitHub fetch rejects', async () => {
    const settings = makeSettings();
    const log = { warn: vi.fn() };
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('econnreset'));

    const release = await new ClientVersionsService(settings as never, log).availableClientVersion();

    expect(release).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), 'github release fetch failed');
  });

  it('returns null on a non-ok npm response with no cache', async () => {
    const settings = makeSettings();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);

    const release = await new ClientVersionsService(settings as never).availableClientVersion(
      false,
      'claude',
    );

    expect(release).toBeNull();
  });

  it('returns null and warns when the npm fetch rejects', async () => {
    const settings = makeSettings();
    const log = { warn: vi.fn() };
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('etimedout'));

    const release = await new ClientVersionsService(settings as never, log).availableClientVersion(
      false,
      'claude',
    );

    expect(release).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), 'npm release fetch failed');
  });

  it('returns null when npm reports no semantic version', async () => {
    const settings = makeSettings();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ version: 'nightly' }));

    const release = await new ClientVersionsService(settings as never).availableClientVersion(
      false,
      'claude',
    );

    expect(release).toBeNull();
  });

  it('serves the cached Claude release inside the TTL', async () => {
    const settings = makeSettings({
      'github_release_claude-cli': cachedRelease('claude-cli', '2.1.173'),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected upstream fetch'));

    const release = await new ClientVersionsService(settings as never).availableClientVersion(
      false,
      'claude',
    );

    expect(release).toMatchObject({ name: 'claude-cli', version: '2.1.173', cached: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ClientVersionsService version locks', () => {
  it('stores a Codex pin under the unsuffixed key and publishes', async () => {
    const settings = makeSettings();
    const publish = vi.spyOn(wsPublisher, 'publish').mockImplementation(() => {});

    const result = await new ClientVersionsService(settings as never).setCodexVersionLock('0.137.0');

    expect(settings.set).toHaveBeenCalledWith('client_version_lock', '0.137.0');
    expect(settings.delete).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('settings.changed', { key: 'client_version_lock' });
    expect(result).toEqual({ locked_version: '0.137.0', locked_at: SET_AT });
  });

  it('clears the Codex pin on null and publishes', async () => {
    const settings = makeSettings({ client_version_lock: '0.137.0' });
    const publish = vi.spyOn(wsPublisher, 'publish').mockImplementation(() => {});

    const result = await new ClientVersionsService(settings as never).setCodexVersionLock(null);

    expect(settings.delete).toHaveBeenCalledWith('client_version_lock');
    expect(settings.set).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('settings.changed', { key: 'client_version_lock' });
    expect(result).toEqual({ locked_version: null, locked_at: null });
  });

  it('stores a Claude pin under the _claude key and publishes', async () => {
    const settings = makeSettings();
    const publish = vi.spyOn(wsPublisher, 'publish').mockImplementation(() => {});

    const result = await new ClientVersionsService(settings as never).setClaudeVersionLock('2.1.173');

    expect(settings.set).toHaveBeenCalledWith('client_version_lock_claude', '2.1.173');
    expect(settings.delete).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('settings.changed', { key: 'client_version_lock_claude' });
    expect(result).toEqual({ locked_version: '2.1.173', locked_at: SET_AT });
  });

  it('clears the Claude pin on null and publishes', async () => {
    const settings = makeSettings({ client_version_lock_claude: '2.1.173' });
    const publish = vi.spyOn(wsPublisher, 'publish').mockImplementation(() => {});

    const result = await new ClientVersionsService(settings as never).setClaudeVersionLock(null);

    expect(settings.delete).toHaveBeenCalledWith('client_version_lock_claude');
    expect(settings.set).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('settings.changed', {
      key: 'client_version_lock_claude',
    });
    expect(result).toEqual({ locked_version: null, locked_at: null });
  });
});

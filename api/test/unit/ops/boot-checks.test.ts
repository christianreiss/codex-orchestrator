import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import { runBootChecks } from '../../../src/ops/boot-checks.js';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';
import { ENGINES } from '../../../src/util/engine.js';

const env = {
  ENCRYPTION_ACTIVE_KEY: Buffer.alloc(32, 7).toString('base64'),
} as Env;

function renderedSql(query: SQL): string {
  return new MySqlDialect().sqlToQuery(query).sql;
}

afterEach(() => vi.unstubAllGlobals());

describe('boot database checks', () => {
  it('probes the required Claude artifact table before optional boot work', async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({
      from: () => ({ where: async () => [{ version: 'complete' }] }),
    }));

    await runBootChecks(env, { execute, select } as unknown as Database);

    expect(execute.mock.calls.map(([query]) => renderedSql(query as SQL))).toEqual([
      'SELECT 1',
      'SELECT 1 FROM claude_artifacts LIMIT 0',
      'SELECT generation, superseded_at, purge_after FROM auth_payloads LIMIT 0',
      'SELECT 1 FROM auth_canonical_heads LIMIT 0',
    ]);
    expect(select).toHaveBeenCalledOnce();
  });

  it('fails startup when the required Claude artifact table is missing', async () => {
    const missing = new Error("Table 'codex_auth.claude_artifacts' doesn't exist");
    const execute = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(missing);

    await expect(runBootChecks(env, { execute } as unknown as Database)).rejects.toBe(missing);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('mirrors one common cxx target into all three engine compatibility keys', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'cxx-boot-check-'));
    const payload = 'cxx test binary';
    const sha256 = createHash('sha256').update(payload).digest('hex');
    for (const platform of ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64']) {
      const [os, arch] = platform.split('-');
      const manifestPath = join(dataRoot, 'wrapper', 'v2', 'bin', 'cxx', platform, 'manifest.json');
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(
        manifestPath,
        JSON.stringify({
          engine: 'cxx',
          os,
          arch,
          current: '2.0.0',
          builds: [{ version: '2.0.0', sha256, size_bytes: Buffer.byteLength(payload) }],
        }),
      );
      const binaryPath = join(dirname(manifestPath), 'v2.0.0', 'cxx');
      await mkdir(dirname(binaryPath), { recursive: true });
      await writeFile(binaryPath, payload);
    }

    const execute = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({
      from: () => ({ where: async () => [{ version: 'complete' }] }),
    }));

    try {
      await runBootChecks(
        {
          ...env,
          DATA_ROOT: dataRoot,
          PUBLIC_BASE_URL: 'https://orchestrator.example/',
        },
        { execute, select } as unknown as Database,
      );

      const writes = execute.mock.calls
        .slice(4)
        .map(([query]) => new MySqlDialect().sqlToQuery(query as SQL).params.slice(0, 2));
      const commonUrl = 'https://orchestrator.example/wrapper/v2/bin/cxx/linux-amd64/v2.0.0/cxx';
      expect(writes).toEqual([
        ['wrapper_version_codex', '2.0.0'],
        ['wrapper_sha256_codex', sha256],
        ['wrapper_url_codex', commonUrl],
        ['wrapper_version_claude', '2.0.0'],
        ['wrapper_sha256_claude', sha256],
        ['wrapper_url_claude', commonUrl],
        ['wrapper_version_grok', '2.0.0'],
        ['wrapper_sha256_grok', sha256],
        ['wrapper_url_grok', commonUrl],
      ]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('leaves published wrapper keys untouched for a partial cxx platform matrix', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'cxx-partial-boot-check-'));
    const payload = 'partial cxx binary';
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const manifestPath = join(
      dataRoot,
      'wrapper',
      'v2',
      'bin',
      'cxx',
      'linux-amd64',
      'manifest.json',
    );
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        engine: 'cxx',
        os: 'linux',
        arch: 'amd64',
        current: '2.0.0',
        builds: [{ version: '2.0.0', sha256, size_bytes: Buffer.byteLength(payload) }],
      }),
    );
    const binaryPath = join(dirname(manifestPath), 'v2.0.0', 'cxx');
    await mkdir(dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, payload);

    const execute = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({
      from: () => ({ where: async () => [{ version: 'complete' }] }),
    }));

    try {
      await runBootChecks(
        { ...env, DATA_ROOT: dataRoot, PUBLIC_BASE_URL: 'https://orchestrator.example/' },
        { execute, select } as unknown as Database,
      );
      expect(execute).toHaveBeenCalledTimes(4);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('leaves published wrapper keys untouched when one cxx checksum is invalid', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'cxx-corrupt-boot-check-'));
    const payload = 'complete cxx binary';
    const sha256 = createHash('sha256').update(payload).digest('hex');
    for (const platform of ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64']) {
      const [os, arch] = platform.split('-');
      const manifestPath = join(dataRoot, 'wrapper', 'v2', 'bin', 'cxx', platform, 'manifest.json');
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(
        manifestPath,
        JSON.stringify({
          engine: 'cxx',
          os,
          arch,
          current: '2.0.0',
          builds: [
            {
              version: '2.0.0',
              sha256: platform === 'darwin-arm64' ? '0'.repeat(64) : sha256,
              size_bytes: Buffer.byteLength(payload),
            },
          ],
        }),
      );
      const binaryPath = join(dirname(manifestPath), 'v2.0.0', 'cxx');
      await mkdir(dirname(binaryPath), { recursive: true });
      await writeFile(binaryPath, payload);
    }

    const execute = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({
      from: () => ({ where: async () => [{ version: 'complete' }] }),
    }));

    try {
      await runBootChecks(
        { ...env, DATA_ROOT: dataRoot, PUBLIC_BASE_URL: 'https://orchestrator.example/' },
        { execute, select } as unknown as Database,
      );
      expect(execute).toHaveBeenCalledTimes(4);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['an empty object', {}],
    [
      'null builds',
      {
        engine: 'cxx',
        os: 'linux',
        arch: 'amd64',
        current: '2.0.0',
        builds: null,
      },
    ],
    [
      'a mismatched artifact identity',
      {
        engine: 'codex',
        os: 'linux',
        arch: 'amd64',
        current: '2.0.0',
        builds: [
          { version: '2.0.0', sha256: '0'.repeat(64), size_bytes: 0 },
        ],
      },
    ],
    [
      'a traversal-like version',
      {
        engine: 'cxx',
        os: 'linux',
        arch: 'amd64',
        current: '../../escape',
        builds: [
          { version: '../../escape', sha256: '0'.repeat(64), size_bytes: 0 },
        ],
      },
    ],
  ])('does not throw or update wrapper pointers for %s', async (_label, manifest) => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'cxx-invalid-boot-check-'));
    const manifestPath = join(
      dataRoot,
      'wrapper',
      'v2',
      'bin',
      'cxx',
      'linux-amd64',
      'manifest.json',
    );
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest));

    const execute = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({
      from: () => ({ where: async () => [{ version: 'complete' }] }),
    }));

    try {
      await expect(
        runBootChecks(
          { ...env, DATA_ROOT: dataRoot, PUBLIC_BASE_URL: 'https://orchestrator.example/' },
          { execute, select } as unknown as Database,
        ),
      ).resolves.toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(4);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('rejects a split manifest whose identity does not match its boot path', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'split-identity-boot-check-'));
    const payload = 'legacy codex binary';
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const manifestPath = join(
      dataRoot,
      'wrapper',
      'v2',
      'bin',
      'codex',
      'linux-amd64',
      'manifest.json',
    );
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        engine: 'claude',
        os: 'linux',
        arch: 'amd64',
        current: '2.0.0',
        builds: [{ version: '2.0.0', sha256, size_bytes: Buffer.byteLength(payload) }],
      }),
    );
    const binaryPath = join(dirname(manifestPath), 'v2.0.0', 'cdx');
    await mkdir(dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, payload);

    const execute = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({
      from: () => ({ where: async () => [{ version: 'complete' }] }),
    }));

    try {
      await runBootChecks(
        { ...env, DATA_ROOT: dataRoot, PUBLIC_BASE_URL: 'https://orchestrator.example/' },
        { execute, select } as unknown as Database,
      );
      expect(execute).toHaveBeenCalledTimes(4);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('publishes only the two legacy split artifacts when no common cxx release exists', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'legacy-split-boot-check-'));
    const payload = 'legacy split test binary';
    const sha256 = createHash('sha256').update(payload).digest('hex');
    for (const [engine, binary] of [['codex', 'cdx'], ['claude', 'clx'], ['grok', 'cgx']] as const) {
      const root = join(dataRoot, 'wrapper', 'v2', 'bin', engine, 'linux-amd64');
      await mkdir(join(root, 'v2.0.0'), { recursive: true });
      await writeFile(join(root, 'manifest.json'), JSON.stringify({
        engine, os: 'linux', arch: 'amd64', current: '2.0.0',
        builds: [{ version: '2.0.0', sha256, size_bytes: Buffer.byteLength(payload) }],
      }));
      await writeFile(join(root, 'v2.0.0', binary), payload);
    }
    const execute = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({ from: () => ({ where: async () => [{ version: 'complete' }] }) }));
    try {
      await runBootChecks({ ...env, DATA_ROOT: dataRoot, PUBLIC_BASE_URL: 'https://orchestrator.example/' }, { execute, select } as unknown as Database);
      const keys = execute.mock.calls.slice(4).map(([query]) => new MySqlDialect().sqlToQuery(query as SQL).params[0]);
      expect(keys).toEqual([
        'wrapper_version_codex', 'wrapper_sha256_codex', 'wrapper_url_codex',
        'wrapper_version_claude', 'wrapper_sha256_claude', 'wrapper_url_claude',
      ]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

describe('boot runner health projections', () => {
  const healthEnv = { ...env, AUTH_RUNNER_URL: 'http://runner.example/verify', AUTH_RUNNER_TIMEOUT: 2 } as Env;
  const healthy = { available: true, version_matches: true };

  async function bootWithResponse(body: unknown, ok = true): Promise<Map<string, unknown>> {
    const fetch = vi.fn().mockResolvedValue({ ok, json: async () => body });
    vi.stubGlobal('fetch', fetch);
    const execute = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({ from: () => ({ where: async () => [{ version: 'complete' }] }) }));
    await runBootChecks(healthEnv, { execute, select } as unknown as Database);
    expect(fetch).toHaveBeenCalledWith('http://runner.example/health', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    return new Map(execute.mock.calls.slice(4).map(([query]) => {
      const params = new MySqlDialect().sqlToQuery(query as SQL).params;
      return [String(params[0]), params[1]];
    }));
  }

  it('records success and fresh timestamps independently for all three engines', async () => {
    const writes = await bootWithResponse({ status: 'ok', engines: Object.fromEntries(ENGINES.map(engine => [engine, healthy])) });
    for (const suffix of ['', '_claude', '_grok']) {
      expect(writes.get(`runner_state${suffix}`)).toBe('ok');
      expect(writes.get(`runner_last_check${suffix}`)).toEqual(expect.any(String));
      expect(writes.get(`runner_last_ok${suffix}`)).toBe(writes.get(`runner_last_check${suffix}`));
      expect(writes.has(`runner_last_fail${suffix}`)).toBe(false);
    }
  });

  it.each(ENGINES)('keeps healthy engines usable when %s reports a mismatched CLI', async broken => {
    const writes = await bootWithResponse({
      status: 'degraded', engines: Object.fromEntries(ENGINES.map(engine => [engine, { ...healthy, version_matches: engine !== broken }])),
    });
    for (const engine of ENGINES) {
      const suffix = engine === 'codex' ? '' : `_${engine}`;
      expect(writes.get(`runner_state${suffix}`)).toBe(engine === broken ? 'fail' : 'ok');
      expect(writes.has(`runner_last_${engine === broken ? 'fail' : 'ok'}${suffix}`)).toBe(true);
    }
  });

  it.each([undefined, { available: false }, { available: true, version_matches: false }])('marks only Grok failed when its evidence is %j', async grok => {
    const writes = await bootWithResponse({ status: 'degraded', engines: { codex: healthy, claude: healthy, grok } });
    expect(writes.get('runner_state')).toBe('ok');
    expect(writes.get('runner_state_claude')).toBe('ok');
    expect(writes.get('runner_state_grok')).toBe('fail');
  });

  it.each([null, { status: 'ok' }, { engines: { codex: healthy, claude: healthy, grok: healthy } }])('fails all three engines for an HTTP error regardless of body %j', async body => {
    const writes = await bootWithResponse(body, false);
    expect(['', '_claude', '_grok'].map(suffix => writes.get(`runner_state${suffix}`))).toEqual(['fail', 'fail', 'fail']);
  });

  it('fails all three engines and records failure timestamps when health cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('runner unreachable')));
    const execute = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({ from: () => ({ where: async () => [{ version: 'complete' }] }) }));
    await runBootChecks(healthEnv, { execute, select } as unknown as Database);
    const writes = new Map(execute.mock.calls.slice(4).map(([query]) => {
      const params = new MySqlDialect().sqlToQuery(query as SQL).params;
      return [String(params[0]), params[1]];
    }));
    for (const suffix of ['', '_claude', '_grok']) {
      expect(writes.get(`runner_state${suffix}`)).toBe('fail');
      expect(writes.get(`runner_last_fail${suffix}`)).toBe(writes.get(`runner_last_check${suffix}`));
    }
  });
});

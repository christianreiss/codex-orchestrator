import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import { runBootChecks } from '../../../src/ops/boot-checks.js';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';

const env = {
  ENCRYPTION_ACTIVE_KEY: Buffer.alloc(32, 7).toString('base64'),
} as Env;

function renderedSql(query: SQL): string {
  return new MySqlDialect().sqlToQuery(query).sql;
}

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

  it('mirrors one common cxx target into both engine compatibility keys', async () => {
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
});

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWrapperBinRegistry } from '../../../src/services/wrapper-bin-registry.js';
import { projectWrapperVersionSnapshot } from '../../../src/services/wrapper-version-projection.js';
import type { VersionSnapshot } from '../../../src/services/version-snapshot.js';

function snapshot(): VersionSnapshot {
  return {
    client_version: '0.130.0',
    client_version_override: null,
    client_version_enforce_exact: false,
    wrapper_version: '2.0.0',
    wrapper_sha256: 'a'.repeat(64),
    wrapper_url: 'https://example.test/wrapper/v2/bin/cxx/linux-amd64/v2.0.0/cxx',
    runner_state: 'ok',
    api_disabled: false,
    auto_update_enabled: true,
    cdx_silent: false,
    clx_silent: false,
    agent_messaging_enabled: false,
    installation_id: 'test',
    engine: 'codex',
  };
}

async function writePublishedBuild(
  root: string,
  artifact: 'cxx' | 'codex',
  platform: 'linux-amd64' | 'linux-arm64' | 'darwin-amd64' | 'darwin-arm64',
  payload: string,
): Promise<string> {
  const [os, arch] = platform.split('-') as [string, string];
  const binaryName = artifact === 'cxx' ? 'cxx' : 'cdx';
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const binary = join(root, artifact, platform, 'v2.0.0', binaryName);
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, payload);
  await writeFile(
    join(root, artifact, platform, 'manifest.json'),
    JSON.stringify({
      engine: artifact,
      os,
      arch,
      current: '2.0.0',
      builds: [{ version: '2.0.0', sha256, size_bytes: Buffer.byteLength(payload) }],
    }),
  );
  return sha256;
}

describe('wrapper version projection', () => {
  it('projects the exact Darwin arm64 artifact instead of the stored Linux tuple', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-projection-'));
    const payload = 'darwin arm64 cxx';
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const binary = join(root, 'cxx', 'darwin-arm64', 'v2.0.0', 'cxx');
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, payload);
    await writeFile(
      join(root, 'cxx', 'darwin-arm64', 'manifest.json'),
      JSON.stringify({
        engine: 'cxx',
        os: 'darwin',
        arch: 'arm64',
        current: '2.0.0',
        builds: [{ version: '2.0.0', sha256, size_bytes: Buffer.byteLength(payload) }],
      }),
    );

    try {
      const projected = await projectWrapperVersionSnapshot({
        snapshot: snapshot(),
        engine: 'codex',
        submittedWrapperVersion: '1.9.0',
        platform: { os: 'darwin', arch: 'arm64' },
        publicBaseUrl: 'https://example.test/',
        binaries: createWrapperBinRegistry({ binRoot: root }),
      });
      expect(projected).toMatchObject({
        wrapper_version: '2.0.0',
        wrapper_sha256: sha256,
        wrapper_url: 'https://example.test/wrapper/v2/bin/cxx/darwin-arm64/v2.0.0/cxx',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the requested platform has no exact validated target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-projection-missing-'));
    try {
      const projected = await projectWrapperVersionSnapshot({
        snapshot: snapshot(),
        engine: 'codex',
        submittedWrapperVersion: '1.9.0',
        platform: { os: 'darwin', arch: 'arm64' },
        publicBaseUrl: 'https://example.test',
        binaries: createWrapperBinRegistry({ binRoot: root }),
      });
      expect(projected).toMatchObject({
        wrapper_version: null,
        wrapper_sha256: null,
        wrapper_url: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails a date-wrapper transition closed without a published artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-projection-legacy-'));
    try {
      const projected = await projectWrapperVersionSnapshot({
        snapshot: snapshot(),
        engine: 'codex',
        submittedWrapperVersion: '2026.05.11-01',
        platform: { os: 'darwin', arch: 'arm64' },
        publicBaseUrl: 'https://example.test',
        binaries: createWrapperBinRegistry({ binRoot: root }),
      });
      expect(projected).toMatchObject({
        wrapper_version: null,
        wrapper_sha256: null,
        wrapper_url: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects split bytes directly for a date wrapper when cxx is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-projection-split-legacy-'));
    try {
      const sha256 = await writePublishedBuild(
        root,
        'codex',
        'darwin-arm64',
        'historical split cdx',
      );
      const projected = await projectWrapperVersionSnapshot({
        snapshot: snapshot(),
        engine: 'codex',
        submittedWrapperVersion: '2026.05.11-01',
        platform: { os: 'darwin', arch: 'arm64' },
        publicBaseUrl: 'https://example.test',
        binaries: createWrapperBinRegistry({ binRoot: root }),
      });
      expect(projected).toMatchObject({
        wrapper_version: '2.0.0',
        wrapper_sha256: sha256,
        wrapper_url:
          'https://example.test/wrapper/v2/bin/codex/darwin-arm64/v2.0.0/cdx',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the transition launcher only for a complete common cxx matrix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-projection-cxx-legacy-'));
    try {
      for (const platform of [
        'linux-amd64',
        'linux-arm64',
        'darwin-amd64',
        'darwin-arm64',
      ] as const) {
        await writePublishedBuild(root, 'cxx', platform, `common cxx ${platform}`);
      }
      const projected = await projectWrapperVersionSnapshot({
        snapshot: snapshot(),
        engine: 'codex',
        submittedWrapperVersion: '2026.05.11-01',
        platform: { os: 'darwin', arch: 'arm64' },
        publicBaseUrl: 'https://example.test',
        binaries: createWrapperBinRegistry({ binRoot: root }),
      });
      expect(projected).toMatchObject({
        wrapper_version: '2.0.0',
        wrapper_sha256: null,
        wrapper_url: '/wrapper/download?engine=codex',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

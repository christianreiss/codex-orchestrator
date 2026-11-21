import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createWrapperBinRegistry,
  BinaryNotFoundError,
  validatePlatformManifest,
  versionCompare,
  SUPPORTED_WRAPPER_PLATFORMS,
} from '../../../src/services/wrapper-bin-registry.js';

const BIN_ROOT = resolve(import.meta.dirname, '..', '..', 'fixtures', 'wrapper-v2', 'bin');

describe('wrapper-bin-registry', () => {
  it('loads a manifest.json for a platform with one', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const m = await reg.manifestForPlatform('codex', 'linux-amd64');
    expect(m).not.toBeNull();
    expect(m!.current).toBe('1.0.1');
    expect(m!.builds.length).toBe(2);
  });

  it('loads the common cxx manifest without treating cxx as an engine', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const m = await reg.manifestForPlatform('cxx', 'linux-amd64');
    expect(m?.engine).toBe('cxx');
    expect(m?.current).toBe('1.0.1');
  });

  it('returns null for an unknown platform', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    expect(await reg.manifestForPlatform('codex', 'nope-zzz')).toBeNull();
    expect(await reg.manifestForPlatform('codex', 'not-a-platform-string-2!!')).toBeNull();
  });

  it('projects the same common current build into both engines', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const codex = await reg.currentBuild('codex', 'linux', 'amd64');
    const claude = await reg.currentBuild('claude', 'linux', 'amd64');
    expect(codex).toEqual(claude);
    expect(codex?.version).toBe('1.0.1');
    expect(codex?.sha256).toBe('9fffd05c3633248e9442c56817d5bd9b6861e1ebcb63d856d42774277d5f0a66');
  });

  it.each([['0.9.187', true], ['0.9.188', false]] as const)(
    'serves a four-platform publication at %s only under its original release contract',
    async (version, available) => {
      const root = await mkdtemp(join(tmpdir(), 'cxx-old-matrix-'));
      try {
        for (const platform of SUPPORTED_WRAPPER_PLATFORMS.filter(p => p !== 'freebsd-amd64')) {
          const [os, arch] = platform.split('-');
          const base = join(root, 'cxx', platform);
          await mkdir(join(base, `v${version}`), { recursive: true });
          await writeFile(join(base, `v${version}`, 'cxx'), platform);
          await writeFile(join(base, 'manifest.json'), JSON.stringify({
            engine: 'cxx', os, arch, current: version,
            builds: [{ version, sha256: createHash('sha256').update(platform).digest('hex'), size_bytes: platform.length }],
          }));
        }
        const registry = createWrapperBinRegistry({ binRoot: root });
        expect((await registry.currentBuild('codex', 'darwin', 'arm64'))?.version).toBe(available ? version : undefined);
        expect(await registry.currentBuild('codex', 'freebsd', 'amd64')).toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('fails closed after a common cxx publication starts instead of falling back to split bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-registry-mismatch-'));
    const commonPath = join(root, 'cxx', 'darwin-arm64', 'v2.0.0', 'cxx');
    const legacyPath = join(root, 'codex', 'darwin-arm64', 'v1.9.0', 'cdx');
    await mkdir(dirname(commonPath), { recursive: true });
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(commonPath, 'corrupt common');
    await writeFile(legacyPath, 'valid legacy');
    await writeFile(
      join(root, 'cxx', 'darwin-arm64', 'manifest.json'),
      JSON.stringify({
        engine: 'cxx',
        os: 'darwin',
        arch: 'arm64',
        current: '2.0.0',
        builds: [
          { version: '2.0.0', sha256: '0'.repeat(64), size_bytes: 14 },
        ],
      }),
    );
    const legacySha = createHash('sha256').update('valid legacy').digest('hex');
    await writeFile(
      join(root, 'codex', 'darwin-arm64', 'manifest.json'),
      JSON.stringify({
        engine: 'codex',
        os: 'darwin',
        arch: 'arm64',
        current: '1.9.0',
        builds: [{ version: '1.9.0', sha256: legacySha, size_bytes: 12 }],
      }),
    );

    try {
      const resolved = await createWrapperBinRegistry({ binRoot: root }).resolveCurrentBuild(
        'codex',
        'darwin',
        'arm64',
      );
      expect(resolved).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to a directory scan when no manifest exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-registry-scan-'));
    const binary = join(root, 'codex', 'freebsd-amd64', 'v1.0.1', 'cdx');
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, 'directory scan binary');
    try {
      const reg = createWrapperBinRegistry({ binRoot: root });
      const cur = await reg.currentBuild('codex', 'freebsd', 'amd64');
      expect(cur?.version).toBe('1.0.1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never serves an unmanifested canonical cxx binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-registry-orphan-cxx-'));
    const binary = join(root, 'cxx', 'linux-amd64', 'v2.0.0', 'cxx');
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, 'orphan common binary');
    try {
      const reg = createWrapperBinRegistry({ binRoot: root });
      await expect(reg.binaryDescriptor('cxx', 'linux', 'amd64', '2.0.0')).resolves.toBeNull();
      await expect(reg.resolveVersion('codex', 'linux', 'amd64', '2.0.0')).resolves.toBeNull();
      await expect(reg.openBinary('cxx', 'linux', 'amd64', '2.0.0')).rejects.toBeInstanceOf(
        BinaryNotFoundError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts nonnegative size metadata but never serves a zero-byte executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-registry-empty-cxx-'));
    const binary = join(root, 'cxx', 'linux-amd64', 'v2.0.0', 'cxx');
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, '');
    const emptySha = createHash('sha256').update('').digest('hex');
    await writeFile(
      join(root, 'cxx', 'linux-amd64', 'manifest.json'),
      JSON.stringify({
        engine: 'cxx',
        os: 'linux',
        arch: 'amd64',
        current: '2.0.0',
        builds: [{ version: '2.0.0', sha256: emptySha, size_bytes: 0 }],
      }),
    );
    try {
      const reg = createWrapperBinRegistry({ binRoot: root });
      expect(await reg.manifestForPlatform('cxx', 'linux-amd64')).not.toBeNull();
      await expect(reg.binaryDescriptor('cxx', 'linux', 'amd64', '2.0.0')).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns null when no binaries are published', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    expect(await reg.currentBuild('codex', 'plan9', 'mips64')).toBeNull();
  });

  it('strictly validates manifest identity, build fields, membership, and metadata', () => {
    const build = {
      version: '2.0.0',
      sha256: 'a'.repeat(64),
      size_bytes: 0,
      signature: 'signed',
      published_at: '2026-07-29T12:00:00Z',
    };
    const manifest = {
      engine: 'cxx',
      os: 'linux',
      arch: 'amd64',
      current: '2.0.0',
      builds: [build],
    };

    expect(validatePlatformManifest(manifest, 'cxx', 'linux-amd64')).toEqual(manifest);

    const invalid = [
      {},
      { ...manifest, builds: null },
      { ...manifest, engine: 'codex' },
      { ...manifest, os: 'darwin' },
      { ...manifest, arch: 'arm64' },
      { ...manifest, current: '2.0.1' },
      { ...manifest, current: '../../escape', builds: [{ ...build, version: '../../escape' }] },
      { ...manifest, builds: [build, { ...build, version: 'v2.0.0' }] },
      { ...manifest, builds: [{ ...build, sha256: 'not-a-sha' }] },
      { ...manifest, builds: [{ ...build, size_bytes: -1 }] },
      { ...manifest, builds: [{ ...build, size_bytes: 1.5 }] },
      { ...manifest, builds: [{ ...build, size_bytes: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...manifest, builds: [{ ...build, signature: 'x'.repeat(16_385) }] },
      { ...manifest, builds: [{ ...build, published_at: 'not-rfc3339' }] },
    ];
    for (const candidate of invalid) {
      expect(validatePlatformManifest(candidate, 'cxx', 'linux-amd64')).toBeNull();
    }
  });

  it.each([
    ['an empty object', {}],
    [
      'null builds',
      { engine: 'cxx', os: 'linux', arch: 'amd64', current: '2.0.0', builds: null },
    ],
    [
      'a mismatched identity',
      {
        engine: 'claude',
        os: 'darwin',
        arch: 'arm64',
        current: '2.0.0',
        builds: [{ version: '2.0.0', sha256: 'a'.repeat(64), size_bytes: 14 }],
      },
    ],
  ])('treats a present manifest with %s as authoritative invalid state', async (_label, manifest) => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-registry-invalid-manifest-'));
    const binary = join(root, 'cxx', 'linux-amd64', 'v2.0.0', 'cxx');
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, 'common payload');
    await writeFile(
      join(root, 'cxx', 'linux-amd64', 'manifest.json'),
      JSON.stringify(manifest),
    );

    try {
      const reg = createWrapperBinRegistry({ binRoot: root });
      await expect(reg.manifestForPlatform('cxx', 'linux-amd64')).resolves.toBeNull();
      await expect(reg.resolveCurrentBuild('codex', 'linux', 'amd64')).resolves.toBeNull();
      await expect(reg.resolveVersion('codex', 'linux', 'amd64', '2.0.0')).resolves.toBeNull();
      await expect(reg.binaryDescriptor('cxx', 'linux', 'amd64', '2.0.0')).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects traversal-like requested versions before resolving a filesystem path', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    await expect(
      reg.resolveVersion('codex', 'linux', 'amd64', '../../1.0.1'),
    ).resolves.toBeNull();
    await expect(
      reg.binaryDescriptor('codex', 'linux', 'amd64', '../../1.0.1'),
    ).resolves.toBeNull();
  });

  it('describes a specific binary file', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const desc = await reg.binaryDescriptor('codex', 'linux', 'amd64', '1.0.1');
    expect(desc).not.toBeNull();
    expect(desc!.sha256).toBe('2ec65cbf202501a60ae44bbee3eb3a2d4f584d51bb8f7a39f84f31a76ded0e72');
    expect(desc!.size).toBeGreaterThan(0);
  });

  it('prefers immutable split history over a same-version common artifact', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const opened = await reg.openBinary('codex', 'linux', 'amd64', '1.0.1');
    const chunks: Buffer[] = [];
    for await (const c of opened.stream) chunks.push(Buffer.from(c as Buffer));
    expect(opened.fileName).toBe('cdx');
    expect(Buffer.concat(chunks).toString('utf8').trim()).toBe('cdx-binary-v1.0.1-payload');
  });

  it('serves common bytes through a legacy alias when split history is absent', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const opened = await reg.openBinary('claude', 'linux', 'amd64', '1.0.1');
    const chunks: Buffer[] = [];
    for await (const c of opened.stream) chunks.push(Buffer.from(c as Buffer));
    expect(opened.fileName).toBe('clx');
    expect(Buffer.concat(chunks).toString('utf8').trim()).toBe('cxx-binary-v1.0.1-common-payload');
  });

  it('opens the canonical cxx artifact by its artifact identity', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const opened = await reg.openBinary('cxx', 'linux', 'amd64', '1.0.1');
    opened.stream.destroy();
    expect(opened.fileName).toBe('cxx');
    expect(opened.sha256).toBe('9fffd05c3633248e9442c56817d5bd9b6861e1ebcb63d856d42774277d5f0a66');
  });

  it('returns null for a non-existent binary', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    expect(await reg.binaryDescriptor('codex', 'linux', 'amd64', '9.9.9')).toBeNull();
  });

  it('opens a read stream for an existing binary', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const opened = await reg.openBinary('codex', 'linux', 'amd64', '1.0.0');
    expect(opened.fileName).toBe('cdx');
    const chunks: Buffer[] = [];
    for await (const c of opened.stream) {
      chunks.push(Buffer.from(c as Buffer));
    }
    const body = Buffer.concat(chunks).toString('utf8').trim();
    expect(body).toBe('cdx-binary-v1.0.0-payload');
  });

  it('rejects v-prefixed versions consistently', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const opened = await reg.openBinary('codex', 'linux', 'amd64', 'v1.0.1');
    opened.stream.destroy();
  });

  it('throws BinaryNotFoundError when opening a missing binary', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    await expect(reg.openBinary('codex', 'linux', 'amd64', '9.9.9')).rejects.toBeInstanceOf(
      BinaryNotFoundError,
    );
  });

  it('versionCompare handles numeric segments numerically', () => {
    expect(versionCompare('1.0.1', '1.0.2')).toBeLessThan(0);
    expect(versionCompare('1.0.10', '1.0.2')).toBeGreaterThan(0);
    expect(versionCompare('1.0.0', '1.0.0')).toBe(0);
    expect(versionCompare('1.0.0-rc1', '1.0.0')).toBeLessThan(0);
  });

  it('reloads an atomically replaced manifest with the original build time and length', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wrapper-manifest-'));
    try {
      const path = join(dir, 'codex', 'linux-amd64', 'manifest.json');
      const manifest = JSON.parse(await readFile(join(BIN_ROOT, 'codex', 'linux-amd64', 'manifest.json'), 'utf8'));
      const source = JSON.stringify(manifest);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
      await utimes(path, 1_800_000_000, 1_800_000_000);
      const reg = createWrapperBinRegistry({ binRoot: dir });
      expect((await reg.manifestForPlatform('codex', 'linux-amd64'))?.current).toBe('1.0.1');
      const updated = JSON.stringify({ ...manifest, current: '1.0.0' });
      expect(updated).toHaveLength(source.length);
      await writeFile(path + '.new', updated);
      await utimes(path + '.new', 1_800_000_000, 1_800_000_000);
      await rename(path + '.new', path);
      expect((await reg.manifestForPlatform('codex', 'linux-amd64'))?.current).toBe('1.0.0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('invalidate() drops cached manifest reads', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    await reg.manifestForPlatform('codex', 'linux-amd64');
    reg.invalidate(); // no throw; cache is dropped
    const again = await reg.manifestForPlatform('codex', 'linux-amd64');
    expect(again!.current).toBe('1.0.1');
  });
});

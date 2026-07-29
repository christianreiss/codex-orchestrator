import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createWrapperBinRegistry } from '../../../src/services/wrapper-bin-registry.js';
import { createWrapperMetaService } from '../../../src/services/wrapper-meta.js';

const BIN_ROOT = resolve(import.meta.dirname, '..', '..', 'fixtures', 'wrapper-v2', 'bin');

describe('wrapper-meta', () => {
  it('returns the current binary descriptor for a platform', async () => {
    const meta = createWrapperMetaService({
      binaries: createWrapperBinRegistry({ binRoot: BIN_ROOT }),
      schemaVersion: 1,
    });
    const r = await meta.forPlatform('codex', 'linux', 'amd64', 'https://x.example.com');
    expect(r).not.toBeNull();
    expect(r!.version).toBe('1.0.1');
    expect(r!.platform).toBe('linux-amd64');
    expect(r!.binary_url).toBe('https://x.example.com/wrapper/v2/bin/cxx/linux-amd64/v1.0.1/cxx');
  });

  it('returns null when no build is published for the requested platform', async () => {
    const meta = createWrapperMetaService({
      binaries: createWrapperBinRegistry({ binRoot: BIN_ROOT }),
      schemaVersion: 1,
    });
    expect(await meta.forPlatform('codex', 'plan9', 'mips64', 'https://x.example.com')).toBeNull();
  });

  it('does not activate a platform from a partial cxx publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrapper-meta-partial-'));
    const payload = 'partial common binary';
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
        builds: [
          { version: '2.0.0', sha256, size_bytes: Buffer.byteLength(payload) },
        ],
      }),
    );
    try {
      const meta = createWrapperMetaService({
        binaries: createWrapperBinRegistry({ binRoot: root }),
        schemaVersion: 1,
      });
      expect(await meta.forPlatform('codex', 'darwin', 'arm64', 'https://x.example.com')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds an engine-level meta with all platforms', async () => {
    const meta = createWrapperMetaService({
      binaries: createWrapperBinRegistry({ binRoot: BIN_ROOT }),
      schemaVersion: 1,
    });
    const r = await meta.forEngine('codex', 'https://x.example.com/');
    expect(r.engine).toBe('codex');
    expect(r.schema_version).toBe(1);
    expect(Object.keys(r.platforms).sort()).toEqual([
      'darwin-amd64',
      'darwin-arm64',
      'linux-amd64',
      'linux-arm64',
    ]);
  });

  it('projects the canonical cxx target into Claude meta', async () => {
    const meta = createWrapperMetaService({
      binaries: createWrapperBinRegistry({ binRoot: BIN_ROOT }),
      schemaVersion: 1,
    });
    const r = await meta.forEngine('claude', 'https://x.example.com/');
    expect(r.platforms['linux-amd64']!.url_path).toBe(
      'https://x.example.com/wrapper/v2/bin/cxx/linux-amd64/v1.0.1/cxx',
    );
  });

  it('trims trailing slashes from baseUrl', async () => {
    const meta = createWrapperMetaService({
      binaries: createWrapperBinRegistry({ binRoot: BIN_ROOT }),
      schemaVersion: 1,
    });
    const r = await meta.forPlatform('codex', 'linux', 'amd64', 'https://x.example.com///');
    expect(r!.binary_url.startsWith('https://x.example.com/wrapper/v2/')).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  createWrapperBinRegistry,
  BinaryNotFoundError,
  versionCompare,
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

  it('returns null for an unknown platform', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    expect(await reg.manifestForPlatform('codex', 'nope-zzz')).toBeNull();
    expect(await reg.manifestForPlatform('codex', 'not-a-platform-string-2!!')).toBeNull();
  });

  it('reports the current build via manifest', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const cur = await reg.currentBuild('codex', 'linux', 'amd64');
    expect(cur?.version).toBe('1.0.1');
    expect(cur?.sha256).toMatch(/^bbbb/);
  });

  it('falls back to a directory scan when no manifest exists', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const cur = await reg.currentBuild('codex', 'darwin', 'arm64');
    expect(cur?.version).toBe('1.0.1');
  });

  it('returns null when no binaries are published', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    expect(await reg.currentBuild('codex', 'plan9', 'mips64')).toBeNull();
  });

  it('builds an engine manifest with per-platform URL paths', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const m = await reg.engineManifest('codex', 'https://api.example.com/');
    expect(m.engine).toBe('codex');
    expect(m.platforms['linux-amd64']).toBeDefined();
    expect(m.platforms['linux-amd64']!.url_path).toBe(
      'https://api.example.com/wrapper/v2/bin/codex/linux-amd64/v1.0.1/cdx',
    );
    expect(m.platforms['darwin-arm64']).toBeDefined();
    expect(m.platforms['darwin-arm64']!.url_path).toBe(
      'https://api.example.com/wrapper/v2/bin/codex/darwin-arm64/v1.0.1/cdx',
    );
  });

  it('discovers a clx binary by name', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const m = await reg.engineManifest('claude', 'http://localhost:8080');
    expect(m.platforms['linux-amd64']!.url_path).toBe(
      'http://localhost:8080/wrapper/v2/bin/claude/linux-amd64/v0.5.0/clx',
    );
  });

  it('describes a specific binary file', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    const desc = await reg.binaryDescriptor('codex', 'linux', 'amd64', '1.0.1');
    expect(desc).not.toBeNull();
    expect(desc!.sha256).toMatch(/^bbbb/);
    expect(desc!.size).toBeGreaterThan(0);
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

  it('invalidate() drops cached manifest reads', async () => {
    const reg = createWrapperBinRegistry({ binRoot: BIN_ROOT });
    await reg.manifestForPlatform('codex', 'linux-amd64');
    reg.invalidate(); // no throw; cache is dropped
    const again = await reg.manifestForPlatform('codex', 'linux-amd64');
    expect(again!.current).toBe('1.0.1');
  });
});

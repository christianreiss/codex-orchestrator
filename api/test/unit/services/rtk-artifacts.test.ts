import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRtkArtifactCache,
  loadRtkArtifact,
  rtkArtifacts,
  RTK_ARTIFACTS,
} from '../../../src/services/rtk-artifacts.js';

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'rtk-artifacts-'));
  roots.push(path);
  return path;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe('pinned RTK OSS artifact cache', () => {
  it('uses a lazy, per-process writable temporary cache with private ownership and shutdown cleanup', async () => {
    const temporary = await root();
    const cache = createRtkArtifactCache(temporary);
    const other = createRtkArtifactCache(temporary);
    expect(await readdir(temporary)).toEqual([]);
    try {
      const [path, samePath] = await Promise.all([cache.root(), cache.root()]);
      expect(path).toBe(samePath);
      expect(path).not.toBe(await other.root());
      expect(path).toMatch(/cxx-rtk-[^/]+$/);
      const metadata = await stat(path);
      expect(metadata.mode & 0o777).toBe(0o700);
      if (process.getuid) expect(metadata.uid).toBe(process.getuid());
      await mkdir(join(path, '1.2.0'));
      await writeFile(join(path, '1.2.0', 'archive'), 'cache fixture');
    } finally {
      await Promise.all([cache.close(), other.close()]);
    }
    expect(await readdir(temporary)).toEqual([]);
  });
  it('reports an unavailable temporary directory and does not claim cache readiness', async () => {
    const temporary = await root();
    const cache = createRtkArtifactCache(join(temporary, 'missing'));
    await expect(cache.root()).rejects.toMatchObject({ status: 503, code: 'rtk_artifact_unavailable' });
    expect(await readdir(temporary)).toEqual([]);
    await expect(cache.close()).resolves.toBeUndefined();
  });

  it('exposes only pinned OSS archives through authenticated per-engine mirrors', () => {
    const artifacts = rtkArtifacts('https://fleet.example/', 'grok');
    expect(Object.keys(artifacts)).toEqual(['linux/amd64', 'linux/arm64', 'darwin/amd64', 'darwin/arm64']);
    for (const [platform, artifact] of Object.entries(artifacts)) {
      expect(artifact.url).toBe(
        `https://fleet.example/wrapper/v2/rtk/v1.2.0/${platform.replace('/', '-')}?engine=grok`,
      );
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(RTK_ARTIFACTS[platform as keyof typeof RTK_ARTIFACTS].name).toMatch(/^rtk-oss-/);
    }
  });
  it('rejects unknown versions and platform traversal without touching the network', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const directory = await root();
    await expect(loadRtkArtifact(directory, '../../etc', '1.2.0')).rejects.toMatchObject({ status: 404 });
    await expect(loadRtkArtifact(directory, 'linux-amd64', 'latest')).rejects.toMatchObject({ status: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not serve or replace a corrupt cache with an unverified download and deduplicates concurrent downloads', async () => {
    const directory = await root();
    const path = join(directory, '1.2.0', RTK_ARTIFACTS['linux/amd64'].name);
    await mkdir(join(directory, '1.2.0'));
    await writeFile(path, 'corrupt cache');
    const fetch = vi.fn(async () => new Response('not the signed digest'));
    vi.stubGlobal('fetch', fetch);
    const results = await Promise.allSettled([
      loadRtkArtifact(directory, 'linux-amd64', '1.2.0'),
      loadRtkArtifact(directory, 'linux-amd64', '1.2.0'),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const result of results)
      expect(result).toMatchObject({ status: 'rejected', reason: { code: 'rtk_artifact_unavailable' } });
    expect(await readFile(path, 'utf8')).toBe('corrupt cache');
  });
  it('bounds downloads before buffering an oversized archive', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream)),
    );
    await expect(loadRtkArtifact(await root(), 'linux-arm64', '1.2.0')).rejects.toMatchObject({
      code: 'rtk_artifact_unavailable',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

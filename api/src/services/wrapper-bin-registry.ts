import { stat, readdir, readFile } from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import { join } from 'node:path';
import type { Engine } from '../util/engine.js';

/**
 * Read-only view over `storage/wrapper/v2/bin/<engine>/<os>-<arch>/manifest.json`
 * and the per-version binary files beneath it. Manifests are cached in memory
 * keyed by absolute path; cache entries are invalidated when the file's mtime
 * changes.
 *
 * Manifest shape (matches `storage/wrapper/v2/bin/<engine>/<os>-<arch>/manifest.json`):
 *
 *   {
 *     "engine": "codex",
 *     "os": "linux",
 *     "arch": "amd64",
 *     "current": "0.6.0",
 *     "builds": [
 *       {
 *         "version": "0.6.0",
 *         "sha256": "...",
 *         "size_bytes": 12345,
 *         "signature": "...",
 *         "published_at": "2026-05-12T10:00:00Z"
 *       },
 *       ...
 *     ]
 *   }
 *
 * For platforms without a manifest file (older artifacts) `manifestForPlatform`
 * returns null and `engineManifest` falls back to a directory scan.
 */

export interface BinaryBuild {
  version: string;
  sha256: string;
  size_bytes: number;
  signature?: string | null;
  published_at?: string | null;
}

export interface PlatformManifest {
  engine: string;
  os: string;
  arch: string;
  current: string;
  builds: BinaryBuild[];
}

export interface EngineManifest {
  engine: string;
  platforms: Record<
    string,
    {
      version: string;
      sha256: string;
      size_bytes: number;
      url_path: string;
    }
  >;
}

interface CacheEntry {
  mtimeMs: number;
  data: PlatformManifest | null;
}

export interface WrapperBinRegistry {
  /** Returns the parsed manifest for an engine + `os-arch` platform, or null. */
  manifestForPlatform(engine: Engine, platform: string): Promise<PlatformManifest | null>;
  /** Returns the current build descriptor for engine+os+arch, or null. */
  currentBuild(engine: Engine, os: string, arch: string): Promise<BinaryBuild | null>;
  /** Returns the latest version string for engine+os+arch, or null. */
  latestVersion(engine: Engine, os: string, arch: string): Promise<string | null>;
  /** Aggregates per-platform info into the `EngineManifest` shape served by /manifest. */
  engineManifest(engine: Engine, publicBaseUrl: string): Promise<EngineManifest>;
  /** Returns metadata for a specific binary file, or null when absent. */
  binaryDescriptor(
    engine: Engine,
    os: string,
    arch: string,
    version: string,
  ): Promise<{ path: string; sha256?: string; size: number } | null>;
  /** Opens a read stream for the binary file at engine/os/arch/version. */
  openBinary(
    engine: Engine,
    os: string,
    arch: string,
    version: string,
  ): Promise<{ stream: ReadStream; sha256?: string; size: number; fileName: string }>;
  /** Test seam: drop the cached manifests. */
  invalidate(): void;
}

export interface WrapperBinRegistryOptions {
  binRoot: string;
}

const PLATFORM_RE = /^[a-z0-9]+-[a-z0-9]+$/;

export function createWrapperBinRegistry(opts: WrapperBinRegistryOptions): WrapperBinRegistry {
  const { binRoot } = opts;
  const cache = new Map<string, CacheEntry>();

  async function safeStat(path: string) {
    try {
      return await stat(path);
    } catch {
      return null;
    }
  }

  async function loadManifest(path: string): Promise<PlatformManifest | null> {
    const st = await safeStat(path);
    if (!st || !st.isFile()) return null;
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as PlatformManifest;
      cache.set(path, { mtimeMs: st.mtimeMs, data: parsed });
      return parsed;
    } catch {
      cache.set(path, { mtimeMs: st.mtimeMs, data: null });
      return null;
    }
  }

  function platformDir(engine: string, platform: string): string {
    return join(binRoot, engine, platform);
  }

  function manifestPath(engine: string, platform: string): string {
    return join(platformDir(engine, platform), 'manifest.json');
  }

  function versionDir(engine: string, platform: string, version: string): string {
    return join(platformDir(engine, platform), `v${stripVPrefix(version)}`);
  }

  function binaryName(engine: Engine): string {
    return engine === 'claude' ? 'clx' : 'cdx';
  }

  function binaryPath(engine: Engine, os: string, arch: string, version: string): string {
    return join(versionDir(engine, `${os}-${arch}`, version), binaryName(engine));
  }

  async function listPlatforms(engine: string): Promise<string[]> {
    try {
      const entries = await readdir(join(binRoot, engine), { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && PLATFORM_RE.test(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  async function fallbackBuildFromDir(
    engine: Engine,
    platform: string,
  ): Promise<BinaryBuild | null> {
    const dir = platformDir(engine, platform);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return null;
    }
    const versions = entries
      .filter((e) => /^v.+/.test(e))
      .map((e) => e.slice(1))
      .sort(versionCompare);
    const latest = versions.at(-1);
    if (!latest) return null;
    const [os, arch] = platform.split('-') as [string, string];
    const path = binaryPath(engine, os, arch, latest);
    const st = await safeStat(path);
    if (!st || !st.isFile()) return null;
    return { version: latest, sha256: '', size_bytes: st.size };
  }

  return {
    async manifestForPlatform(engine, platform) {
      if (!PLATFORM_RE.test(platform)) return null;
      return loadManifest(manifestPath(engine, platform));
    },

    async currentBuild(engine, os, arch) {
      const platform = `${os}-${arch}`;
      const manifest = await loadManifest(manifestPath(engine, platform));
      if (manifest) {
        const current =
          manifest.builds.find((b) => b.version === manifest.current) ?? manifest.builds.at(-1);
        if (current) return current;
      }
      return fallbackBuildFromDir(engine, platform);
    },

    async latestVersion(engine, os, arch) {
      const cur = await this.currentBuild(engine, os, arch);
      return cur?.version ?? null;
    },

    async engineManifest(engine, publicBaseUrl) {
      const platforms = await listPlatforms(engine);
      const base = publicBaseUrl.replace(/\/+$/, '');
      const out: EngineManifest = { engine, platforms: {} };
      for (const platform of platforms) {
        const [os, arch] = platform.split('-') as [string, string];
        const build = await this.currentBuild(engine, os, arch);
        if (!build) continue;
        out.platforms[platform] = {
          version: build.version,
          sha256: build.sha256,
          size_bytes: build.size_bytes,
          url_path: `${base}/wrapper/v2/bin/${engine}/${platform}/v${build.version}/${binaryName(engine)}`,
        };
      }
      return out;
    },

    async binaryDescriptor(engine, os, arch, version) {
      const path = binaryPath(engine, os, arch, version);
      const st = await safeStat(path);
      if (!st || !st.isFile()) return null;
      const manifest = await loadManifest(manifestPath(engine, `${os}-${arch}`));
      const build = manifest?.builds.find((b) => b.version === stripVPrefix(version));
      return { path, sha256: build?.sha256, size: st.size };
    },

    async openBinary(engine, os, arch, version) {
      const desc = await this.binaryDescriptor(engine, os, arch, version);
      if (!desc) {
        throw new BinaryNotFoundError(
          `wrapper binary not found: ${engine}/${os}-${arch}/v${stripVPrefix(version)}`,
        );
      }
      return {
        stream: createReadStream(desc.path),
        sha256: desc.sha256,
        size: desc.size,
        fileName: binaryName(engine),
      };
    },

    invalidate() {
      cache.clear();
    },
  };
}

export class BinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinaryNotFoundError';
  }
}

function stripVPrefix(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version;
}

/**
 * Loose semver-ish compare for `<MAJOR>.<MINOR>.<PATCH>(-prerelease)?`.
 * Numeric segments compare numerically; a version with a prerelease tail
 * sorts *below* the same version without one (e.g. 1.0.0-rc1 < 1.0.0).
 */
export function versionCompare(a: string, b: string): number {
  const [aCore, aPre] = splitPre(a);
  const [bCore, bPre] = splitPre(b);
  const pa = aCore.split('.');
  const pb = bCore.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? '0';
    const bi = pb[i] ?? '0';
    const an = Number(ai);
    const bn = Number(bi);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return an < bn ? -1 : 1;
      continue;
    }
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  // Cores equal: the version without a prerelease tail wins.
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) return aPre < bPre ? -1 : aPre > bPre ? 1 : 0;
  return 0;
}

function splitPre(v: string): [string, string] {
  const idx = v.indexOf('-');
  if (idx === -1) return [v, ''];
  return [v.slice(0, idx), v.slice(idx + 1)];
}

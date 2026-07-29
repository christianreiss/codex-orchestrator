import { stat, readdir, readFile } from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Engine } from '../util/engine.js';
import { isRfc3339 } from '../util/timestamp.js';

/**
 * Read-only view over the canonical
 * `storage/wrapper/v2/bin/cxx/<os>-<arch>/manifest.json` artifact and the
 * historical per-engine trees beneath the same root. Manifests are cached in
 * memory keyed by absolute path; cache entries are invalidated when the file's
 * mtime changes.
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
  engine: Engine;
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

/** `cxx` is an artifact identity, deliberately not an orchestrator Engine. */
export const CXX_ARTIFACT = 'cxx' as const;
export type WrapperArtifact = Engine | typeof CXX_ARTIFACT;

export interface ResolvedWrapperBuild extends BinaryBuild {
  artifact: WrapperArtifact;
  path: string;
}

interface CacheEntry {
  mtimeMs: number;
  data: PlatformManifest | null;
}

interface DigestCacheEntry {
  mtimeMs: number;
  size: number;
  sha256: string;
}

export interface WrapperBinRegistry {
  /** Returns the parsed manifest for an artifact + `os-arch` platform, or null. */
  manifestForPlatform(
    artifact: WrapperArtifact,
    platform: string,
  ): Promise<PlatformManifest | null>;
  /** Returns the current build descriptor for engine+os+arch, or null. */
  currentBuild(engine: Engine, os: string, arch: string): Promise<BinaryBuild | null>;
  /** Resolves the current artifact and its exact checksum-validated file atomically. */
  resolveCurrentBuild(
    engine: Engine,
    os: string,
    arch: string,
  ): Promise<ResolvedWrapperBuild | null>;
  /** Resolves one exact published version without mixing artifact sources. */
  resolveVersion(
    engine: Engine,
    os: string,
    arch: string,
    version: string,
  ): Promise<ResolvedWrapperBuild | null>;
  /** Returns the latest version string for engine+os+arch, or null. */
  latestVersion(engine: Engine, os: string, arch: string): Promise<string | null>;
  /** Aggregates per-platform info into the `EngineManifest` shape served by /manifest. */
  engineManifest(engine: Engine, publicBaseUrl: string): Promise<EngineManifest>;
  /** Returns metadata for a specific binary file, or null when absent. */
  binaryDescriptor(
    artifact: WrapperArtifact,
    os: string,
    arch: string,
    version: string,
  ): Promise<{ path: string; sha256?: string; size: number } | null>;
  /** Opens a read stream for the binary file at artifact/os/arch/version. */
  openBinary(
    artifact: WrapperArtifact,
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
const PLATFORM_COMPONENT_RE = /^[a-z0-9]+$/;
const VERSION_RE = /^(?:v)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const MAX_VERSION_LENGTH = 128;
const MAX_MANIFEST_BUILDS = 4096;
const MAX_SIGNATURE_LENGTH = 16_384;
const MAX_PUBLISHED_AT_LENGTH = 128;
export const SUPPORTED_WRAPPER_PLATFORMS = [
  'linux-amd64',
  'linux-arm64',
  'darwin-amd64',
  'darwin-arm64',
] as const;

/** Runtime validation for untrusted on-disk wrapper publication metadata. */
export function validatePlatformManifest(
  value: unknown,
  artifact: WrapperArtifact,
  platform: string,
): PlatformManifest | null {
  if (!PLATFORM_RE.test(platform)) return null;
  const [expectedOs, expectedArch] = platform.split('-') as [string, string];
  if (!isRecord(value)) return null;
  if (
    value.engine !== artifact ||
    value.os !== expectedOs ||
    value.arch !== expectedArch ||
    !isSafeVersion(value.current) ||
    !Array.isArray(value.builds) ||
    value.builds.length < 1 ||
    value.builds.length > MAX_MANIFEST_BUILDS
  ) {
    return null;
  }

  const builds: BinaryBuild[] = [];
  const versions = new Set<string>();
  for (const candidate of value.builds) {
    if (!isRecord(candidate) || !isSafeVersion(candidate.version)) return null;
    const version = stripVPrefix(candidate.version);
    if (versions.has(version)) return null;
    versions.add(version);
    if (typeof candidate.sha256 !== 'string' || !SHA256_RE.test(candidate.sha256)) return null;
    if (
      typeof candidate.size_bytes !== 'number' ||
      !Number.isSafeInteger(candidate.size_bytes) ||
      candidate.size_bytes < 0
    ) {
      return null;
    }
    if (
      candidate.signature !== undefined &&
      candidate.signature !== null &&
      (typeof candidate.signature !== 'string' ||
        candidate.signature.length > MAX_SIGNATURE_LENGTH)
    ) {
      return null;
    }
    if (
      candidate.published_at !== undefined &&
      candidate.published_at !== null &&
      (typeof candidate.published_at !== 'string' ||
        candidate.published_at.length > MAX_PUBLISHED_AT_LENGTH ||
        !isRfc3339(candidate.published_at))
    ) {
      return null;
    }
    builds.push({
      version,
      sha256: candidate.sha256.toLowerCase(),
      size_bytes: candidate.size_bytes,
      ...(candidate.signature === undefined ? {} : { signature: candidate.signature }),
      ...(candidate.published_at === undefined
        ? {}
        : { published_at: candidate.published_at }),
    });
  }

  const current = stripVPrefix(value.current);
  if (!versions.has(current)) return null;
  return { engine: artifact, os: expectedOs, arch: expectedArch, current, builds };
}

export function wrapperBinaryUrl(
  publicBaseUrl: string,
  artifact: WrapperArtifact,
  os: string,
  arch: string,
  version: string,
): string {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return `${base}/wrapper/v2/bin/${artifact}/${os}-${arch}/v${stripVPrefix(version)}/${binaryName(artifact)}`;
}

function binaryName(artifact: WrapperArtifact): 'cxx' | 'cdx' | 'clx' {
  if (artifact === CXX_ARTIFACT) return CXX_ARTIFACT;
  return artifact === 'claude' ? 'clx' : 'cdx';
}

export function createWrapperBinRegistry(opts: WrapperBinRegistryOptions): WrapperBinRegistry {
  const { binRoot } = opts;
  const cache = new Map<string, CacheEntry>();
  const digestCache = new Map<string, DigestCacheEntry>();

  async function safeStat(path: string) {
    try {
      return await stat(path);
    } catch {
      return null;
    }
  }

  async function loadManifest(
    path: string,
    artifact: WrapperArtifact,
    platform: string,
  ): Promise<PlatformManifest | null> {
    const st = await safeStat(path);
    if (!st || !st.isFile()) return null;
    const mtimeMs = Number(st.mtimeMs);
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.data;
    try {
      const raw = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const validated = validatePlatformManifest(parsed, artifact, platform);
      cache.set(path, { mtimeMs, data: validated });
      return validated;
    } catch {
      cache.set(path, { mtimeMs, data: null });
      return null;
    }
  }

  function platformDir(artifact: string, platform: string): string {
    return join(binRoot, artifact, platform);
  }

  function manifestPath(artifact: string, platform: string): string {
    return join(platformDir(artifact, platform), 'manifest.json');
  }

  function versionDir(artifact: string, platform: string, version: string): string {
    return join(platformDir(artifact, platform), `v${stripVPrefix(version)}`);
  }

  function binaryPath(
    artifact: WrapperArtifact,
    os: string,
    arch: string,
    version: string,
  ): string {
    return join(versionDir(artifact, `${os}-${arch}`, version), binaryName(artifact));
  }

  async function listPlatforms(artifact: string): Promise<string[]> {
    try {
      const entries = await readdir(join(binRoot, artifact), { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && PLATFORM_RE.test(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  async function sha256File(
    path: string,
    knownStat?: Awaited<ReturnType<typeof stat>>,
  ): Promise<string | null> {
    try {
      const st = knownStat ?? (await stat(path));
      const mtimeMs = Number(st.mtimeMs);
      const size = Number(st.size);
      const cached = digestCache.get(path);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached.sha256;
      }
      return await new Promise<string>((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(path);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => {
          const sha256 = hash.digest('hex');
          digestCache.set(path, { mtimeMs, size, sha256 });
          resolve(sha256);
        });
      });
    } catch {
      return null;
    }
  }

  async function fallbackBuildFromDir(
    artifact: WrapperArtifact,
    platform: string,
  ): Promise<BinaryBuild | null> {
    const dir = platformDir(artifact, platform);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return null;
    }
    const versions = entries
      .filter((e) => /^v.+/.test(e))
      .map((e) => e.slice(1))
      .filter(isSafeVersion)
      .sort(versionCompare);
    const [os, arch] = platform.split('-') as [string, string];
    for (const version of versions.reverse()) {
      const descriptor = await directBinaryDescriptor(artifact, os, arch, version);
      if (!descriptor?.sha256) continue;
      return { version, sha256: descriptor.sha256, size_bytes: descriptor.size };
    }
    return null;
  }

  async function resolveArtifactCurrent(
    artifact: WrapperArtifact,
    os: string,
    arch: string,
  ): Promise<ResolvedWrapperBuild | null> {
    const platform = `${os}-${arch}`;
    if (!PLATFORM_RE.test(platform)) return null;
    const path = manifestPath(artifact, platform);
    const manifest = await loadManifest(path, artifact, platform);
    if (manifest) {
      // A present manifest is authoritative. If `current` is missing,
      // incomplete, or its bytes do not match the recorded digest, do not
      // silently select a different version from the same tree.
      const current = manifest.builds.find(
        (candidate) => stripVPrefix(candidate.version) === stripVPrefix(manifest.current),
      );
      if (!current) return null;
      const descriptor = await directBinaryDescriptor(artifact, os, arch, current.version);
      if (!descriptor?.sha256) return null;
      return {
        ...current,
        version: stripVPrefix(current.version),
        sha256: descriptor.sha256,
        size_bytes: descriptor.size,
        artifact,
        path: descriptor.path,
      };
    }
    // A manifest file is authoritative even when malformed or unreadable.
    // Directory scanning remains compatibility-only for trees with no
    // manifest, never a way around invalid publication metadata.
    if (await safeStat(path)) return null;
    const fallback = await fallbackBuildFromDir(artifact, platform);
    if (!fallback) return null;
    return {
      ...fallback,
      artifact,
      path: binaryPath(artifact, os, arch, fallback.version),
    };
  }

  async function commonCurrentVersion(): Promise<string | null> {
    const resolved = await Promise.all(
      SUPPORTED_WRAPPER_PLATFORMS.map(async (platform) => {
        if (
          !(await loadManifest(
            manifestPath(CXX_ARTIFACT, platform),
            CXX_ARTIFACT,
            platform,
          ))
        ) {
          return null;
        }
        const [os, arch] = platform.split('-') as [string, string];
        return resolveArtifactCurrent(CXX_ARTIFACT, os, arch);
      }),
    );
    if (resolved.some((build) => build === null)) return null;
    const versions = new Set(resolved.map((build) => build!.version));
    return versions.size === 1 ? resolved[0]!.version : null;
  }

  return {
    async manifestForPlatform(artifact, platform) {
      if (!PLATFORM_RE.test(platform)) return null;
      return loadManifest(manifestPath(artifact, platform), artifact, platform);
    },

    async currentBuild(engine, os, arch) {
      const resolved = await this.resolveCurrentBuild(engine, os, arch);
      if (!resolved) return null;
      const { artifact: _artifact, path: _path, ...build } = resolved;
      return build;
    },

    async resolveCurrentBuild(engine, os, arch) {
      const platform = `${os}-${arch}`;
      const eligibleCommonVersion = await commonCurrentVersion();
      if (eligibleCommonVersion) {
        const common = await resolveArtifactCurrent(CXX_ARTIFACT, os, arch);
        if (common?.version === eligibleCommonVersion) return common;
      }
      if (
        SUPPORTED_WRAPPER_PLATFORMS.includes(
          platform as (typeof SUPPORTED_WRAPPER_PLATFORMS)[number],
        ) &&
        (await safeStat(join(binRoot, CXX_ARTIFACT)))
      ) {
        return null;
      }
      return resolveArtifactCurrent(engine, os, arch);
    },

    async resolveVersion(engine, os, arch, version) {
      if (
        !PLATFORM_COMPONENT_RE.test(os) ||
        !PLATFORM_COMPONENT_RE.test(arch) ||
        !isSafeVersion(version)
      ) {
        return null;
      }
      const normalizedVersion = stripVPrefix(version);
      for (const artifact of [CXX_ARTIFACT, engine] as const) {
        const descriptor = await directBinaryDescriptor(
          artifact,
          os,
          arch,
          normalizedVersion,
        );
        if (!descriptor?.sha256) continue;
        const platform = `${os}-${arch}`;
        const manifest = await loadManifest(
          manifestPath(artifact, platform),
          artifact,
          platform,
        );
        const build = manifest?.builds.find(
          (candidate) => stripVPrefix(candidate.version) === normalizedVersion,
        );
        return {
          version: normalizedVersion,
          sha256: descriptor.sha256,
          size_bytes: descriptor.size,
          signature: build?.signature,
          published_at: build?.published_at,
          artifact,
          path: descriptor.path,
        };
      }
      return null;
    },

    async latestVersion(engine, os, arch) {
      const cur = await this.currentBuild(engine, os, arch);
      return cur?.version ?? null;
    },

    async engineManifest(engine, publicBaseUrl) {
      const platforms = [
        ...new Set([...(await listPlatforms(CXX_ARTIFACT)), ...(await listPlatforms(engine))]),
      ].sort();
      const out: EngineManifest = { engine, platforms: {} };
      for (const platform of platforms) {
        const [os, arch] = platform.split('-') as [string, string];
        const build = await this.resolveCurrentBuild(engine, os, arch);
        if (!build) continue;
        out.platforms[platform] = {
          version: build.version,
          sha256: build.sha256,
          size_bytes: build.size_bytes,
          url_path: wrapperBinaryUrl(publicBaseUrl, build.artifact, os, arch, build.version),
        };
      }
      return out;
    },

    async binaryDescriptor(artifact, os, arch, version) {
      // Existing split URLs are immutable: if an exact historical cdx/clx
      // artifact exists it always wins. New versions transparently fall back
      // to the common cxx bytes so those URLs remain compatible.
      if (artifact !== CXX_ARTIFACT) {
        const legacy = await directBinaryDescriptor(artifact, os, arch, version);
        if (legacy) return legacy;
        return directBinaryDescriptor(CXX_ARTIFACT, os, arch, version);
      }
      return directBinaryDescriptor(CXX_ARTIFACT, os, arch, version);
    },

    async openBinary(artifact, os, arch, version) {
      const desc = await this.binaryDescriptor(artifact, os, arch, version);
      if (!desc) {
        throw new BinaryNotFoundError(
          `wrapper binary not found: ${artifact}/${os}-${arch}/v${stripVPrefix(version)}`,
        );
      }
      return {
        stream: createReadStream(desc.path),
        sha256: desc.sha256,
        size: desc.size,
        fileName: binaryName(artifact),
      };
    },

    invalidate() {
      cache.clear();
      digestCache.clear();
    },
  };

  async function directBinaryDescriptor(
    artifact: WrapperArtifact,
    os: string,
    arch: string,
    version: string,
  ): Promise<{ path: string; sha256?: string; size: number } | null> {
    if (
      !PLATFORM_COMPONENT_RE.test(os) ||
      !PLATFORM_COMPONENT_RE.test(arch) ||
      !isSafeVersion(version)
    ) {
      return null;
    }
    const normalizedVersion = stripVPrefix(version);
    const path = binaryPath(artifact, os, arch, normalizedVersion);
    const st = await safeStat(path);
    if (!st || !st.isFile() || st.size === 0) return null;
    const platform = `${os}-${arch}`;
    const pathToManifest = manifestPath(artifact, platform);
    const manifest = await loadManifest(pathToManifest, artifact, platform);
    if (!manifest && (artifact === CXX_ARTIFACT || (await safeStat(pathToManifest)))) {
      return null;
    }
    const build = manifest?.builds.find(
      (candidate) => stripVPrefix(candidate.version) === normalizedVersion,
    );
    // When a manifest exists it is authoritative: unlisted files and files
    // whose size/digest differ are incomplete or corrupt publication state.
    if (manifest && !build) return null;
    const expectedSha = build?.sha256?.trim().toLowerCase() ?? null;
    if (expectedSha && !/^[a-f0-9]{64}$/.test(expectedSha)) return null;
    if (build?.size_bytes !== undefined && build.size_bytes !== st.size) return null;
    const actualSha = await sha256File(path, st);
    if (!actualSha || (expectedSha !== null && actualSha !== expectedSha)) return null;
    return { path, sha256: actualSha, size: st.size };
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_VERSION_LENGTH &&
    VERSION_RE.test(value) &&
    VERSION_RE.test(stripVPrefix(value))
  );
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

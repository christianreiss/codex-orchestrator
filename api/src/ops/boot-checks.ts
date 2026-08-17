import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { Keyring } from '../security/keyring.js';
import { sql } from 'drizzle-orm';
import { nowIso } from '../util/timestamp.js';
import { writeRunnerTelemetry } from '../services/runner-telemetry.js';
import { ensureAuthGenerationBackfill } from '../services/auth-generation-retention.js';
import {
  CXX_ARTIFACT,
  validatePlatformManifest,
  wrapperBinaryUrl,
  type BinaryBuild,
  type PlatformManifest,
  type WrapperArtifact,
} from '../services/wrapper-bin-registry.js';

export async function runBootChecks(env: Env, db: Database): Promise<void> {
  const keyring = Keyring.fromEnv(env);

  await db.execute(sql`SELECT 1`);
  // Claude bootstrap always reads this table. Probe it before the listener is
  // opened so a missed additive migration cannot hide behind a green generic
  // database health check and fail only when the first clx host syncs.
  await db.execute(sql`SELECT 1 FROM claude_artifacts LIMIT 0`);
  await db.execute(sql`SELECT generation, superseded_at, purge_after FROM auth_payloads LIMIT 0`);
  await db.execute(sql`SELECT 1 FROM auth_canonical_heads LIMIT 0`);
  await ensureAuthGenerationBackfill(db, keyring);
  await refreshRunnerHealth(env, db);
  await refreshWrapperVersions(env, db);

  if (env.STATIC_ROOT) {
    if (!existsSync(env.STATIC_ROOT) || !statSync(env.STATIC_ROOT).isDirectory()) {
      // Non-fatal: log and continue; static plugin will surface 404s.
      console.warn(`[boot] STATIC_ROOT not found or not a directory: ${env.STATIC_ROOT}`);
    }
  }
}

async function refreshWrapperVersions(env: Env, db: Database): Promise<void> {
  const baseUrl = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) return;

  const binRoot = env.DATA_ROOT
    ? join(env.DATA_ROOT, 'wrapper', 'v2', 'bin')
    : resolve(import.meta.dirname, '..', '..', '..', '..', 'storage', 'wrapper', 'v2', 'bin');
  const publishedAt = nowIso();

  const commonPlatforms = ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'];
  const commonManifests = await Promise.all(
    commonPlatforms.map((platform) =>
      readCurrentBuild(
        join(binRoot, CXX_ARTIFACT, platform, 'manifest.json'),
        CXX_ARTIFACT,
        platform,
      ),
    ),
  );
  const commonPublicationStarted = existsSync(join(binRoot, CXX_ARTIFACT));
  const commonBuilds = await Promise.all(
    commonPlatforms.map(async (platform, index) => {
      const build = commonManifests[index];
      if (!build) return null;
      const binary = join(binRoot, CXX_ARTIFACT, platform, `v${build.version}`, CXX_ARTIFACT);
      return (await binaryMatchesBuild(binary, build)) ? build : null;
    }),
  );
  const commonVersions = new Set(
    commonBuilds.flatMap((build) => (build ? [build.version] : [])),
  );
  const commonBuild = commonBuilds[0] ?? null;
  if (
    commonBuild &&
    commonBuilds.every((build) => build !== null) &&
    commonVersions.size === 1
  ) {
    const url = wrapperBinaryUrl(
      baseUrl,
      CXX_ARTIFACT,
      'linux',
      'amd64',
      commonBuild.version,
    );
    // Keep the compatibility DB keys, but make both engine projections share
    // one source of truth. There is no per-engine cxx target to drift.
    await publishWrapperProjection(db, 'codex', commonBuild, url, publishedAt);
    await publishWrapperProjection(db, 'claude', commonBuild, url, publishedAt);
    return;
  }

  // Once any cxx publication exists, an incomplete/corrupt/mixed-version
  // matrix is a staged or failed release. Leave the last-known-good database
  // pointers untouched instead of falling back to a split Linux artifact.
  if (commonPublicationStarted) return;

  await publishWrapperVersion(db, binRoot, baseUrl, 'codex', 'cdx', publishedAt);
  await publishWrapperVersion(db, binRoot, baseUrl, 'claude', 'clx', publishedAt);
}

async function binaryMatchesBuild(
  path: string,
  build: BinaryBuild,
): Promise<boolean> {
  if (!isFile(path)) return false;
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength === 0 || bytes.byteLength !== build.size_bytes) return false;
    const actual = createHash('sha256').update(bytes).digest('hex');
    return actual === build.sha256.toLowerCase();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function publishWrapperVersion(
  db: Database,
  binRoot: string,
  baseUrl: string,
  engine: 'codex' | 'claude',
  binary: 'cdx' | 'clx',
  publishedAt: string,
): Promise<void> {
  const platform = 'linux-amd64';
  const build = await readCurrentBuild(
    join(binRoot, engine, platform, 'manifest.json'),
    engine,
    platform,
  );
  if (!build) return;
  const path = join(binRoot, engine, platform, `v${build.version}`, binary);
  if (!(await binaryMatchesBuild(path, build))) return;
  const url = `${baseUrl}/wrapper/v2/bin/${engine}/linux-amd64/v${build.version}/${binary}`;
  await publishWrapperProjection(db, engine, build, url, publishedAt);
}

async function publishWrapperProjection(
  db: Database,
  engine: 'codex' | 'claude',
  build: { version: string; sha256: string },
  url: string,
  publishedAt: string,
): Promise<void> {
  const suffix = `_${engine}`;
  await upsertVersion(db, `wrapper_version${suffix}`, build.version, publishedAt);
  await upsertVersion(db, `wrapper_sha256${suffix}`, build.sha256, publishedAt);
  await upsertVersion(db, `wrapper_url${suffix}`, url, publishedAt);
}

async function readManifest(
  path: string,
  artifact: WrapperArtifact,
  platform: string,
): Promise<PlatformManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return validatePlatformManifest(parsed, artifact, platform);
  } catch {
    return null;
  }
}

async function readCurrentBuild(
  path: string,
  artifact: WrapperArtifact,
  platform: string,
): Promise<BinaryBuild | null> {
  const manifest = await readManifest(path, artifact, platform);
  if (!manifest) return null;
  const build = manifest.builds.find((candidate) => candidate.version === manifest.current);
  return build ?? null;
}

async function refreshRunnerHealth(env: Env, db: Database): Promise<void> {
  if (!env.AUTH_RUNNER_URL) return;

  const checkedAt = nowIso();
  const healthUrl = env.AUTH_RUNNER_URL.replace(/\/verify(?:\?.*)?$/, '/health');
  const timeoutMs = Math.max(1000, (env.AUTH_RUNNER_TIMEOUT ?? 8) * 1000);

  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => null)) as RunnerHealthResponse | null;

    await writeRunnerState(db, 'codex', runnerEngineState(res.ok, body, 'codex'), checkedAt);
    await writeRunnerState(db, 'claude', runnerEngineState(res.ok, body, 'claude'), checkedAt);
  } catch {
    await writeRunnerState(db, 'codex', 'fail', checkedAt);
    await writeRunnerState(db, 'claude', 'fail', checkedAt);
  }
}

interface RunnerHealthEngine {
  available?: boolean;
  version?: string | null;
  expected_version?: string | null;
  version_matches?: boolean;
}

interface RunnerHealthResponse {
  status?: string;
  required_engines?: string[];
  engines?: {
    codex?: RunnerHealthEngine;
    claude?: RunnerHealthEngine;
  };
  problems?: string[];
}

/**
 * One engine's verdict from a `/health` body.
 *
 * Deliberately per-engine rather than gated on the top-level `status`: the
 * runner reports `degraded` when *any* required engine is broken, and reading
 * that as "both engines failed" marks a perfectly healthy Codex runner dead
 * because its Claude CLI drifted. `version_matches` counts as a failure for the
 * engine it belongs to — a CLI that is not the one the image was verified with
 * cannot be trusted to say whether a credential is valid.
 */
function runnerEngineState(
  ok: boolean,
  body: RunnerHealthResponse | null,
  engine: 'codex' | 'claude',
): 'ok' | 'fail' {
  if (!ok || !body) return 'fail';
  const state = body.engines?.[engine];
  if (!state) return 'fail';
  if (state.available === false) return 'fail';
  if (state.version_matches === false) return 'fail';
  return 'ok';
}

async function writeRunnerState(
  db: Database,
  engine: 'codex' | 'claude',
  state: 'ok' | 'fail',
  checkedAt: string,
): Promise<void> {
  await writeRunnerTelemetry(db, engine, state, checkedAt);
}

async function upsertVersion(
  db: Database,
  name: string,
  version: string,
  updatedAt: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO versions (name, version, updated_at)
    VALUES (${name}, ${version}, ${updatedAt})
    ON DUPLICATE KEY UPDATE version = VALUES(version), updated_at = VALUES(updated_at)
  `);
}

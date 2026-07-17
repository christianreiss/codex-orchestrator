import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { Keyring } from '../security/keyring.js';
import { sql } from 'drizzle-orm';
import { nowIso } from '../util/timestamp.js';
import { writeRunnerTelemetry } from '../services/runner-telemetry.js';

export async function runBootChecks(env: Env, db: Database): Promise<void> {
  Keyring.fromEnv(env);

  await db.execute(sql`SELECT 1`);
  // Claude bootstrap always reads this table. Probe it before the listener is
  // opened so a missed additive migration cannot hide behind a green generic
  // database health check and fail only when the first clx host syncs.
  await db.execute(sql`SELECT 1 FROM claude_artifacts LIMIT 0`);
  await refreshRunnerHealth(env, db);
  await refreshWrapperVersions(env, db);

  if (env.STATIC_ROOT) {
    if (!existsSync(env.STATIC_ROOT) || !statSync(env.STATIC_ROOT).isDirectory()) {
      // Non-fatal: log and continue; static plugin will surface 404s.
      // eslint-disable-next-line no-console
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

  await publishWrapperVersion(db, binRoot, baseUrl, 'codex', 'cdx', publishedAt);
  await publishWrapperVersion(db, binRoot, baseUrl, 'claude', 'clx', publishedAt);
}

async function publishWrapperVersion(
  db: Database,
  binRoot: string,
  baseUrl: string,
  engine: 'codex' | 'claude',
  binary: 'cdx' | 'clx',
  publishedAt: string,
): Promise<void> {
  const manifest = await readManifest(join(binRoot, engine, 'linux-amd64', 'manifest.json'));
  if (!manifest) return;

  const build =
    manifest.builds.find((candidate) => candidate.version === manifest.current) ??
    manifest.builds.at(-1);
  if (!build?.version || !build.sha256) return;

  const suffix = `_${engine}`;
  const url = `${baseUrl}/wrapper/v2/bin/${engine}/linux-amd64/v${build.version}/${binary}`;
  await upsertVersion(db, `wrapper_version${suffix}`, build.version, publishedAt);
  await upsertVersion(db, `wrapper_sha256${suffix}`, build.sha256, publishedAt);
  await upsertVersion(db, `wrapper_url${suffix}`, url, publishedAt);
}

interface WrapperManifest {
  current: string;
  builds: Array<{ version: string; sha256: string }>;
}

async function readManifest(path: string): Promise<WrapperManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as WrapperManifest;
    if (!parsed || !Array.isArray(parsed.builds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function refreshRunnerHealth(env: Env, db: Database): Promise<void> {
  if (!env.AUTH_RUNNER_URL) return;

  const checkedAt = nowIso();
  const healthUrl = env.AUTH_RUNNER_URL.replace(/\/verify(?:\?.*)?$/, '/health');
  const timeoutMs = Math.max(1000, (env.AUTH_RUNNER_TIMEOUT ?? 8) * 1000);

  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => null)) as RunnerHealthResponse | null;
    const codexOk = res.ok && body?.status === 'ok' && body.engines?.codex?.available !== false;
    const claudeOk = res.ok && body?.status === 'ok' && body.engines?.claude?.available !== false;

    await writeRunnerState(db, 'codex', codexOk ? 'ok' : 'fail', checkedAt);
    await writeRunnerState(db, 'claude', claudeOk ? 'ok' : 'fail', checkedAt);
  } catch {
    await writeRunnerState(db, 'codex', 'fail', checkedAt);
    await writeRunnerState(db, 'claude', 'fail', checkedAt);
  }
}

interface RunnerHealthResponse {
  status?: string;
  engines?: {
    codex?: { available?: boolean };
    claude?: { available?: boolean };
  };
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

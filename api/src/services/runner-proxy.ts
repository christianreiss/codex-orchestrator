import { randomBytes } from 'node:crypto';
import { lt } from 'drizzle-orm';
import { ServiceUnavailableError } from '../http/errors.js';
import type { Env } from '../env.js';
import { createRunnerClient, type RunnerClient, type RunnerVerifyResult } from './runner-client.js';
import type { RunnerValidationService } from './runner-validation.js';
import { ENGINE_CODEX, parseEngine, type Engine } from '../util/engine.js';
import type { Database } from '../db/client.js';
import { authSeedTokens, versions } from '../db/schema.js';
import { nowIso } from '../util/timestamp.js';

type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export interface RunnerStatus {
  configured: boolean;
  url: string | null;
  ready: boolean;
  detail: string;
  state?: 'idle' | 'ok' | 'fail';
  last_run?: string | null;
  last_error?: string | null;
  last_result?: Record<string, unknown> | null;
  engines?: {
    codex: RunnerEngineStatus;
    claude: RunnerEngineStatus;
  };
}

export interface RunnerEngineStatus {
  state: string | null;
  last_check: string | null;
  last_ok: string | null;
  last_fail: string | null;
  last_run: string | null;
  last_error: string | null;
}

export interface RunnerRunRequest {
  prompt?: string;
  engine?: 'codex' | 'claude';
  model?: string | null;
  reasoning_effort?: string | null;
  preview?: boolean;
  timeout_seconds?: number;
}

export interface RunnerRunResult {
  status: 'ok' | 'fail' | 'unconfigured';
  output?: string;
  reason?: string;
  detail?: string;
  reachable?: boolean;
  latency_ms?: number;
  canonical_digest?: string;
  canonical_last_refresh?: string;
  payload_id?: number;
  [key: string]: unknown;
}

export interface RunnerProxyDeps {
  runner?: RunnerClient;
  runnerValidation?: RunnerValidationService;
  db?: Database;
  versionReader?: () => Promise<Map<string, string>>;
}

export class RunnerProxyService {
  private readonly runner: RunnerClient;

  constructor(
    private readonly env: Env,
    private readonly log?: Logger,
    private readonly deps: RunnerProxyDeps = {},
  ) {
    this.runner = deps.runner ?? createRunnerClient({ env });
  }

  async status(): Promise<RunnerStatus> {
    const url = this.env.AUTH_RUNNER_URL ?? null;
    const secret = this.env.AUTH_RUNNER_SHARED_SECRET ?? '';
    if (!url) {
      return { configured: false, url: null, ready: false, detail: 'AUTH_RUNNER_URL is not set' };
    }
    if (!secret) {
      return { configured: true, url, ready: false, detail: 'AUTH_RUNNER_SHARED_SECRET missing' };
    }
    return {
      configured: true,
      url,
      ready: true,
      detail: 'configured',
      ...(await this.readPersistedStatus()),
    };
  }

  async run(payload: RunnerRunRequest, engine: Engine): Promise<RunnerRunResult> {
    const status = await this.status();
    if (!status.ready) {
      return {
        status: status.configured ? 'fail' : 'unconfigured',
        detail: status.detail,
        reason: status.detail,
        reachable: false,
      };
    }

    const validation = this.deps.runnerValidation;
    if (!validation) {
      throw new ServiceUnavailableError('Runner auth validation service is not wired', 'runner_validation_not_wired');
    }

    const canonicalPayload = await validation.resolveCanonicalPayload(engine);
    const validated = validation.validateCanonicalPayload(canonicalPayload);
    if (!canonicalPayload || !validated) {
      const engineLabel = engine === 'claude' ? 'Claude' : 'Codex';
      return {
        status: 'fail',
        reason: `${engineLabel} canonical auth payload unavailable or invalid`,
        detail: `${engineLabel} canonical auth payload unavailable or invalid`,
        reachable: false,
      };
    }

    const timeoutSeconds = typeof payload.timeout_seconds === 'number' ? payload.timeout_seconds : undefined;
    const verdict =
      engine === 'claude'
        ? await this.runner.verifyClaude({ authJson: validated.auth, timeoutSeconds })
        : await this.runner.verify({ authJson: validated.auth, timeoutSeconds });

    return this.formatRunResult(verdict, canonicalPayload.id, validated.digest, validated.last_refresh);
  }

  private formatRunResult(
    verdict: RunnerVerifyResult,
    payloadId: number,
    digest: string,
    lastRefresh: string,
  ): RunnerRunResult {
    const reason = typeof verdict.reason === 'string' ? verdict.reason : undefined;
    return {
      ...verdict,
      status: verdict.status,
      detail: verdict.ok ? 'Runner verification ok' : (reason ?? verdict.status),
      reason,
      canonical_digest: digest,
      canonical_last_refresh: lastRefresh,
      payload_id: payloadId,
    };
  }

  async seedCommand(payload: Record<string, unknown>): Promise<{
    status: string;
    queued: boolean;
    command?: string;
    expires_at?: string;
    engine?: Engine;
  }> {
    const db = this.deps.db;
    if (!db) {
      this.log?.info?.('runner-proxy.seedCommand called (stub)');
      return { status: 'ok', queued: true };
    }

    const baseUrl = resolveSeedBaseUrl(this.env, payload);
    if (!baseUrl) {
      throw new ServiceUnavailableError(
        'Unable to determine public base URL for seed command. Set PUBLIC_BASE_URL.',
        'public_base_url_missing',
      );
    }

    const ttlRaw = this.env.AUTH_SEED_TOKEN_TTL_SECONDS;
    const ttlSeconds = typeof ttlRaw === 'number' && ttlRaw > 0 ? ttlRaw : 900;
    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const createdAt = nowIso();
    const engine: Engine = payload.engine !== undefined ? parseEngine(payload.engine) : ENGINE_CODEX;

    await db.delete(authSeedTokens).where(lt(authSeedTokens.expiresAt, createdAt));

    const token = randomBytes(32).toString('hex');
    await db.insert(authSeedTokens).values({
      token,
      tokenEnc: null,
      baseUrl,
      engine,
      expiresAt,
      usedAt: null,
      createdAt,
    });

    const command = `curl -fsSL "${baseUrl.replace(/\/+$/, '')}/seed/auth/${token}" | bash`;
    return { status: 'ok', queued: true, command, expires_at: expiresAt, engine };
  }

  private async readPersistedStatus(): Promise<Partial<RunnerStatus>> {
    const read = this.deps.versionReader ?? (this.deps.db ? createVersionReader(this.deps.db) : null);
    if (!read) return {};

    const map = await read();
    const codex = normalizeRunnerEngineStatus(runnerEngineStatus(map, ''), 'Codex');
    const claude = normalizeRunnerEngineStatus(runnerEngineStatus(map, '_claude'), 'Claude');
    const state = codex.state === 'fail' || claude.state === 'fail'
      ? 'fail'
      : codex.state === 'ok' || claude.state === 'ok'
        ? 'ok'
        : 'idle';
    const lastRun = latestIso(codex.last_check, claude.last_check, codex.last_ok, claude.last_ok, codex.last_fail, claude.last_fail);

    return {
      state,
      last_run: lastRun,
      last_error: state === 'fail' ? latestFailureLabel(codex, claude) : null,
      last_result: { codex, claude },
      engines: { codex, claude },
    };
  }
}

function resolveSeedBaseUrl(env: Env, payload: Record<string, unknown>): string {
  const fromPayload = typeof payload.base_url === 'string' ? payload.base_url.trim() : '';
  if (fromPayload !== '') return fromPayload.replace(/\/+$/, '');
  const fromEnv = typeof env.PUBLIC_BASE_URL === 'string' ? env.PUBLIC_BASE_URL.trim() : '';
  if (fromEnv !== '') return fromEnv.replace(/\/+$/, '');
  return '';
}

function createVersionReader(db: Database): () => Promise<Map<string, string>> {
  return async () => {
    const rows = await db.select().from(versions);
    return new Map(rows.map((row) => [row.name, row.version]));
  };
}

function runnerEngineStatus(map: Map<string, string>, suffix: '' | '_claude') {
  return {
    state: map.get(`runner_state${suffix}`) ?? null,
    last_check: map.get(`runner_last_check${suffix}`) ?? null,
    last_ok: map.get(`runner_last_ok${suffix}`) ?? null,
    last_fail: map.get(`runner_last_fail${suffix}`) ?? null,
  };
}

function normalizeRunnerEngineStatus(
  status: ReturnType<typeof runnerEngineStatus>,
  label: 'Codex' | 'Claude',
): RunnerEngineStatus {
  const state = status.state ?? null;
  const lastRun = latestIso(status.last_check, status.last_ok, status.last_fail);
  return {
    ...status,
    last_run: lastRun,
    last_error: state === 'fail' && status.last_fail ? `${label} runner failed at ${status.last_fail}` : null,
  };
}

function latestIso(...values: Array<string | null | undefined>): string | null {
  let latest: { value: string; time: number } | null = null;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (!latest || time > latest.time) latest = { value, time };
  }
  return latest?.value ?? null;
}

function latestFailureLabel(
  codex: RunnerEngineStatus,
  claude: RunnerEngineStatus,
): string | null {
  const failures = [codex.last_error, claude.last_error].filter((v): v is string => Boolean(v));
  return failures.length > 0 ? failures.join('; ') : null;
}

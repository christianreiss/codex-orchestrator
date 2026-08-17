import { randomBytes } from 'node:crypto';
import { lt } from 'drizzle-orm';
import { ServiceUnavailableError, ValidationError } from '../http/errors.js';
import type { Env } from '../env.js';
import type { RunnerValidationService } from './runner-validation.js';
import type { CanonicalAuthStoreService } from './canonical-auth-store.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, parseEngine, type Engine } from '../util/engine.js';
import type { Database } from '../db/client.js';
import { authSeedTokens, versions } from '../db/schema.js';
import { isoOffsetSeconds, nowIso } from '../util/timestamp.js';

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

/**
 * The manual runner trigger takes no parameters.
 *
 * It used to declare `prompt`, `model`, `reasoning_effort`, `preview` and
 * `timeout_seconds`. Only `timeout_seconds` ever reached anything, and now that
 * verification runs through the canonical store's own pipeline not even that
 * does — so the whole shape is gone rather than left as a contract the service
 * cannot honor. `assertNoRunRequestFields` rejects a body that still sends them
 * instead of accepting and discarding it.
 */
export type RunnerRunRequest = Record<string, never>;

export interface RunnerRunResult {
  status: 'ok' | 'fail' | 'unconfigured';
  engine?: Engine;
  /**
   * The canonical store's verdict, verbatim:
   *   verified — the credential proved live
   *   failed   — the provider rejected it; the payload is quarantined
   *   unknown  — nothing was proven (runner unreachable, or the credential
   *              cannot be probed without spending its refresh token)
   */
  verdict?: 'verified' | 'failed' | 'unknown';
  /** True when this pass replaced the canonical head with refreshed bytes. */
  applied?: boolean;
  /** True only when a live probe actually ran; absent reachability is not `false`. */
  probed?: boolean;
  reason?: string;
  detail?: string;
  reachable?: boolean;
  latency_ms?: number;
  canonical_digest_before?: string;
  canonical_digest?: string;
  canonical_last_refresh?: string;
  payload_id?: number;
  [key: string]: unknown;
}

export interface SeedTokenGrant {
  token: string;
  baseUrl: string;
  engine: Engine;
  expiresAt: string;
  createdAt: string;
}

/**
 * The two writes `seedCommand` needs, and nothing else.
 *
 * A narrow port rather than the whole `Database`: the service previously took
 * an optional `db`, and the absent case returned `{status:'ok', queued:true}` —
 * a seed command that was never issued, reported as issued. A required port
 * makes that branch unrepresentable.
 */
export interface SeedTokenStore {
  purgeExpired(before: string): Promise<void>;
  issue(grant: SeedTokenGrant): Promise<void>;
}

/** Reads the `versions` rows that carry runner telemetry. */
export type RunnerTelemetryReader = () => Promise<Map<string, string>>;

export interface RunnerProxyDeps {
  runnerValidation: RunnerValidationService;
  authStore: CanonicalAuthStoreService;
  seedTokens: SeedTokenStore;
  readTelemetry: RunnerTelemetryReader;
}

export function createSeedTokenStore(db: Database): SeedTokenStore {
  return {
    async purgeExpired(before) {
      await db.delete(authSeedTokens).where(lt(authSeedTokens.expiresAt, before));
    },
    async issue(grant) {
      await db.insert(authSeedTokens).values({
        token: grant.token,
        tokenEnc: null,
        baseUrl: grant.baseUrl,
        engine: grant.engine,
        expiresAt: grant.expiresAt,
        usedAt: null,
        createdAt: grant.createdAt,
      });
    },
  };
}

export function createRunnerTelemetryReader(db: Database): RunnerTelemetryReader {
  return async () => {
    const rows = await db.select().from(versions);
    return new Map(rows.map((row) => [row.name, row.version]));
  };
}

/**
 * Reject a manual-run body that carries fields the endpoint cannot honor.
 *
 * Accepting `{"prompt": "..."}` and silently ignoring it is the failure mode
 * this exists to prevent: the caller believes it ran a prompt.
 */
export function assertNoRunRequestFields(body: unknown): void {
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Runner run takes no request body', {
      extra: { code_detail: 'runner_run_body_not_allowed' },
    });
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length > 0) {
    throw new ValidationError(`Runner run takes no parameters; received ${keys.sort().join(', ')}`, {
      extra: { code_detail: 'runner_run_body_not_allowed', unexpected: keys.sort() },
    });
  }
}

export class RunnerProxyService {
  constructor(
    private readonly env: Env,
    private readonly log: Logger | undefined,
    private readonly deps: RunnerProxyDeps,
  ) {}

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

  /**
   * Force one verification pass for `engine`.
   *
   * This runs the *same* pipeline as the background worker and the store path:
   * `ensureServedVerification` normalizes and structurally validates any
   * refreshed credentials, promotes them under a compare-and-swap against the
   * canonical head, encrypts them through the store gate, and quarantines what
   * it cannot use. The manual trigger previously probed the runner directly and
   * dropped `updated_auth` on the floor, so a refresh performed on an operator's
   * click was thrown away while the docs claimed the result reported `applied`.
   *
   * Nothing here returns credential bytes. The result carries digests, an id,
   * and a verdict — never `auth`, never `updated_auth`.
   */
  async run(payload: RunnerRunRequest, engine: Engine): Promise<RunnerRunResult> {
    assertNoRunRequestFields(payload);

    const status = await this.status();
    if (!status.ready) {
      return {
        status: status.configured ? 'fail' : 'unconfigured',
        engine,
        detail: status.detail,
        reason: status.detail,
        probed: false,
      };
    }

    const validation = this.deps.runnerValidation;
    const row = await validation.resolveCanonicalPayload(engine);
    const validated = row ? validation.validateCanonicalPayload(row) : null;
    const auth = row ? validation.canonicalAuthFromPayload(row) : null;
    if (!row || !validated || !auth) {
      const label = engine === ENGINE_CLAUDE ? 'Claude' : 'Codex';
      const detail = `${label} canonical auth payload unavailable or invalid`;
      return { status: 'fail', engine, reason: detail, detail, probed: false };
    }

    const before = validated.digest;
    const verdict = await this.deps.authStore.ensureServedVerification({
      engine,
      hostId: null,
      row,
      auth,
      digest: validated.digest,
      lastRefresh: validated.last_refresh,
      // An operator pressing "run verification" is asking for a live answer,
      // not for whatever the last pass cached.
      ttlSeconds: 0,
      forceLive: true,
    });

    const applied = verdict.refreshed || verdict.digest !== before;
    const result: RunnerRunResult = {
      status: verdict.state === 'verified' ? 'ok' : 'fail',
      engine,
      verdict: verdict.state,
      applied,
      probed: verdict.probe !== undefined,
      canonical_digest_before: before,
      canonical_digest: verdict.digest,
      canonical_last_refresh: verdict.lastRefresh,
      payload_id: row.id,
      detail: runVerdictDetail(verdict.state, applied, verdict.reason),
    };
    if (verdict.reason !== undefined) result.reason = verdict.reason;
    if (verdict.probe) {
      result.reachable = verdict.probe.reachable;
      if (verdict.probe.latencyMs !== undefined) result.latency_ms = verdict.probe.latencyMs;
    }
    return result;
  }

  async seedCommand(payload: Record<string, unknown>): Promise<{
    status: string;
    queued: boolean;
    command: string;
    expires_at: string;
    engine: Engine;
  }> {
    const baseUrl = resolveSeedBaseUrl(this.env, payload);
    if (!baseUrl) {
      throw new ServiceUnavailableError(
        'Unable to determine public base URL for seed command. Set PUBLIC_BASE_URL.',
        'public_base_url_missing',
      );
    }

    const ttlRaw = this.env.AUTH_SEED_TOKEN_TTL_SECONDS;
    const ttlSeconds = typeof ttlRaw === 'number' && ttlRaw > 0 ? ttlRaw : 900;
    const expiresAt = isoOffsetSeconds(ttlSeconds);
    const createdAt = nowIso();
    const engine: Engine = payload.engine !== undefined ? parseEngine(payload.engine) : ENGINE_CODEX;

    await this.deps.seedTokens.purgeExpired(createdAt);

    const token = randomBytes(32).toString('hex');
    await this.deps.seedTokens.issue({ token, baseUrl, engine, expiresAt, createdAt });
    this.log?.info?.({ engine, expires_at: expiresAt }, 'runner-proxy.seedCommand issued');

    const command = `curl -fsSL "${baseUrl.replace(/\/+$/, '')}/seed/auth/${token}" | bash`;
    return { status: 'ok', queued: true, command, expires_at: expiresAt, engine };
  }

  private async readPersistedStatus(): Promise<Partial<RunnerStatus>> {
    const map = await this.deps.readTelemetry();
    const [codexCanonical, claudeCanonical] = await Promise.all([
      this.hasVerifiedCanonicalAuth(ENGINE_CODEX),
      this.hasVerifiedCanonicalAuth(ENGINE_CLAUDE),
    ]);
    const codex = normalizeRunnerEngineStatus(runnerEngineStatus(map, ''), 'Codex', codexCanonical);
    const claude = normalizeRunnerEngineStatus(
      runnerEngineStatus(map, '_claude'),
      'Claude',
      claudeCanonical,
    );
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
      ...(canonicalStatusDetail(codexCanonical, claudeCanonical)),
    };
  }

  /**
   * Runner telemetry is historical metadata, whereas a green engine badge is
   * a statement about auth that can be used now.  A fresh database has neither
   * canonical payload nor telemetry; a reused database can retain telemetry
   * after its canonical auth has been removed.  Only expose persisted `ok` /
   * `fail` state when the current canonical row is verified and distributable.
   */
  private async hasVerifiedCanonicalAuth(engine: Engine): Promise<boolean> {
    const validation = this.deps.runnerValidation;
    const row = await validation.resolveCanonicalPayload(engine);
    return (
      row?.verificationState === 'verified' &&
      validation.validateCanonicalPayload(row) !== null &&
      validation.canonicalAuthFromPayload(row) !== null
    );
  }
}

function runVerdictDetail(
  state: 'verified' | 'failed' | 'unknown',
  applied: boolean,
  reason?: string,
): string {
  if (state === 'verified') {
    return applied
      ? 'Runner verification ok; refreshed credentials promoted to canonical'
      : 'Runner verification ok';
  }
  if (state === 'failed') return reason ?? 'Runner verification failed';
  return reason ?? 'Runner verification inconclusive; canonical auth unchanged';
}

function resolveSeedBaseUrl(env: Env, payload: Record<string, unknown>): string {
  const fromPayload = typeof payload.base_url === 'string' ? payload.base_url.trim() : '';
  if (fromPayload !== '') return fromPayload.replace(/\/+$/, '');
  const fromEnv = typeof env.PUBLIC_BASE_URL === 'string' ? env.PUBLIC_BASE_URL.trim() : '';
  if (fromEnv !== '') return fromEnv.replace(/\/+$/, '');
  return '';
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
  canonicalAuth: boolean,
): RunnerEngineStatus {
  if (!canonicalAuth) {
    return {
      state: 'idle',
      last_check: null,
      last_ok: null,
      last_fail: null,
      last_run: null,
      last_error: null,
    };
  }
  const state = status.state ?? null;
  const lastRun = latestIso(status.last_check, status.last_ok, status.last_fail);
  return {
    ...status,
    last_run: lastRun,
    last_error: state === 'fail' && status.last_fail ? `${label} runner failed at ${status.last_fail}` : null,
  };
}

function canonicalStatusDetail(
  codexCanonical: boolean,
  claudeCanonical: boolean,
): Partial<RunnerStatus> {
  const missing = [
    codexCanonical ? null : 'Codex',
    claudeCanonical ? null : 'Claude',
  ].filter((engine): engine is string => engine !== null);
  if (missing.length === 0) return {};
  return { detail: `configured; no verified canonical auth for ${missing.join(' or ')}` };
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

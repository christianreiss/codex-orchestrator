import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import {
  authPayloads,
  authEntries,
  hostAuthDigests,
  hostAuthStates,
  hosts as hostsTable,
  logs as logsTable,
  type Host,
} from '../../db/schema.js';
import type { RouteContext } from '../index.js';
import { ApiError, ServiceUnavailableError, UnauthorizedError, ValidationError } from '../../http/errors.js';
import { nowIso, isRfc3339 } from '../../util/timestamp.js';
import { parseEngine, type Engine, ENGINE_CLAUDE, ENGINE_CODEX } from '../../util/engine.js';
import { wsPublisher } from '../../ws/publisher.js';
import { encrypt } from '../../security/secret-box.js';

import { createAuthFailureTracker } from '../../services/auth-failure-tracker.js';
import { createHostAuthService } from '../../services/host-auth.js';
import { createInsecureWindowService } from '../../services/insecure-window.js';
import { createVersionSnapshotService } from '../../services/version-snapshot.js';
import { createTokenUsageService } from '../../services/token-usage.js';
import { createHostSyncService } from '../../services/host-sync.js';
import {
  createRunnerValidationService,
  extractAuthPayload,
} from '../../services/runner-validation.js';
import { createRunnerClient } from '../../services/runner-client.js';
import { withLegacyShellWrapperTransition } from '../../services/wrapper-transition.js';
import { ChatGptUsageService } from '../../services/chatgpt-usage.js';

const MIN_REFRESH_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 300 * 1000;

/**
 * Registers the wrapper-facing /auth (+ /sync/*) routes. The legacy PHP
 * AuthService is split across:
 *   - host-auth         (validate API key → host row)
 *   - insecure-window   (sliding window + grace + approval)
 *   - runner-validation (canonical payload + digest)
 *   - host-sync         (sync envelope content)
 *   - token-usage       (current-month totals)
 *   - version-snapshot  (versions block)
 *
 * /auth is the wrapper's "what's the latest canonical auth blob" probe;
 * `command=retrieve` (default) compares the host's submitted digest to the
 * canonical one; `command=store` accepts an upload and (if the runner is
 * configured) verifies it before persisting.
 */
export async function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const failures = createAuthFailureTracker(app);
  const hostAuth = createHostAuthService({ db: ctx.db, failures });
  const insecure = createInsecureWindowService({ db: ctx.db, env: ctx.env });
  const versions = createVersionSnapshotService({
    db: ctx.db,
    installationId: ctx.env.INSTALLATION_ID ?? null,
  });
  const tokenUsage = createTokenUsageService({ db: ctx.db });
  const syncService = createHostSyncService({ db: ctx.db, versions, tokenUsage });
  const runnerValidation = createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring });
  const runner = createRunnerClient({ env: ctx.env });

  // POST /auth — primary wrapper probe.
  app.post('/auth', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = parseEngine(payload.engine);
    const command = normalizeCommand(payload.command);
    const enforcedHost = await maybeEnforceInsecure(insecure, host, command);

    if (command === 'retrieve') {
      return handleRetrieve(app, ctx, enforcedHost, payload, engine, runnerValidation, versions, tokenUsage);
    }
    return handleStore(app, ctx, enforcedHost, payload, engine, runnerValidation, runner, versions, tokenUsage);
  });

  // DELETE /auth — host uninstall.
  app.delete('/auth', async (req) => {
    const host = await hostAuth.authenticate(req);
    const force = (req.query as { force?: string })?.force === '1';
    const ip = req.clientIp;
    if (!force && host.ip4 && ip && host.ip4 !== ip && host.ip6 !== ip) {
      throw new UnauthorizedError('API key not allowed from this IP', 'ip_mismatch');
    }
    await ctx.db.delete(hostAuthDigests).where(eq(hostAuthDigests.hostId, host.id));
    await ctx.db.delete(hostsTable).where(eq(hostsTable.id, host.id));
    await ctx.db.insert(logsTable).values({
      hostId: host.id,
      action: 'host.delete',
      details: JSON.stringify({ fqdn: host.fqdn, initiator: 'host_api', force }),
      createdAt: nowIso(),
    });
    wsPublisher.publish('host.deleted', { id: host.id, fqdn: host.fqdn });
    return { deleted: host.fqdn };
  });

  // POST /sync/status — periodic check-in.
  app.post('/sync/status', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = parseEngine(payload.engine);
    const enforced = await maybeEnforceInsecure(insecure, host, 'retrieve');

    const userInput = extractHostUserInput(payload);
    const users = await syncService.recordHostUser(enforced.id, userInput.username, userInput.hostname);
    const out = await syncService.collect({ host: enforced, engine, bootstrap: false });
    out.versions = withLegacyShellWrapperTransition(out.versions, payload.wrapper_version, engine);
    out.host_users = users;

    const includeAuth = normalizeBoolean(payload.include_auth) !== false;
    if (includeAuth) {
      const authResult = await handleRetrieve(app, ctx, enforced, payload, engine, runnerValidation, versions, tokenUsage);
      out.auth = authResult;
      const authStatus = ((authResult as { status?: string }).status ?? '').toLowerCase();
      if (authStatus !== 'valid') {
        out.reasons.push(`auth_${authStatus !== '' ? authStatus : 'unknown'}`);
      }
    }
    out.reasons = uniqueNonEmpty(out.reasons);
    out.status = out.reasons.length === 0 ? 'ok' : 'update';
    return out;
  });

  // POST /sync/bootstrap — full first-run sync.
  app.post('/sync/bootstrap', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = parseEngine(payload.engine);
    const enforced = await maybeEnforceInsecure(insecure, host, 'retrieve');

    const userInput = extractHostUserInput(payload);
    const users = await syncService.recordHostUser(enforced.id, userInput.username, userInput.hostname);
    const out = await syncService.collect({ host: enforced, engine, bootstrap: true });
    out.versions = withLegacyShellWrapperTransition(out.versions, payload.wrapper_version, engine);
    out.host_users = users;

    const includeAuth = normalizeBoolean(payload.include_auth) !== false;
    if (includeAuth) {
      const authResult = await handleRetrieve(app, ctx, enforced, payload, engine, runnerValidation, versions, tokenUsage);
      out.auth = authResult;
      const status = ((authResult as { status?: string }).status ?? '').toLowerCase();
      if (status !== 'valid') {
        out.reasons.push(`auth_${status !== '' ? status : 'unknown'}`);
      }
    }
    out.reasons = uniqueNonEmpty(out.reasons);
    out.status = out.reasons.length === 0 ? 'ok' : 'update';
    return out;
  });
}

// ───────────────────────────────────────────────────────────────────────────
// /auth retrieve / store
// ───────────────────────────────────────────────────────────────────────────

async function handleRetrieve(
  app: FastifyInstance,
  ctx: RouteContext,
  host: Host,
  payload: Record<string, unknown>,
  engine: Engine,
  runnerValidation: ReturnType<typeof createRunnerValidationService>,
  versionSvc: ReturnType<typeof createVersionSnapshotService>,
  tokenUsage: ReturnType<typeof createTokenUsageService>,
): Promise<Record<string, unknown>> {
  const providedDigest = extractDigest(payload, false);
  const incomingLast =
    typeof payload.last_refresh === 'string' && payload.last_refresh.trim() !== ''
      ? payload.last_refresh.trim()
      : null;
  if (incomingLast) assertReasonableLastRefresh(incomingLast, 'last_refresh');

  const canonicalRow = await runnerValidation.resolveCanonicalPayload(engine);
  const validated = runnerValidation.validateCanonicalPayload(canonicalRow);
  const canonicalDigest = validated?.digest ?? null;
  const canonicalLast = validated?.last_refresh ?? null;
  const canonicalAuth = validated?.auth ?? null;

  // Bump api_calls.
  await ctx.db
    .update(hostsTable)
    .set({ apiCalls: (Number(host.apiCalls ?? 0) + 1), updatedAt: nowIso() })
    .where(eq(hostsTable.id, host.id));

  const versions = withLegacyShellWrapperTransition(
    await versionSvc.summary(engine),
    payload.wrapper_version,
    engine,
  );
  const totals = await tokenUsage.totalsForMonth(host.id);
  const baseResponse: Record<string, unknown> = {
    canonical_last_refresh: canonicalLast,
    canonical_digest: canonicalDigest,
    host: buildHostPayload(host),
    api_calls: Number(host.apiCalls ?? 0) + 1,
    token_usage_month: totals,
    versions,
    quota_hard_fail: host.vip === 1 ? false : await versionSvc.flag('quota_hard_fail', true),
    quota_limit_percent: await readQuotaLimitPercent(versionSvc),
    cdx_silent: versions.cdx_silent,
    engine,
  };
  if (engine === ENGINE_CODEX) {
    baseResponse.chatgpt = await readChatgptSnapshot(ctx);
  }

  if (!canonicalRow || !canonicalDigest) {
    return {
      ...baseResponse,
      status: 'missing',
      action: 'store',
    };
  }

  const incomingTs = incomingLast ? Date.parse(incomingLast) : 0;
  const canonicalTs = canonicalLast ? Date.parse(canonicalLast) : 0;
  const matchesCanonical = providedDigest && canonicalDigest && providedDigest === canonicalDigest;

  if (matchesCanonical) {
    await touchHostState(ctx, host.id, canonicalRow.id, canonicalDigest, engine, canonicalLast!);
    return { ...baseResponse, status: 'valid' };
  }
  if (incomingTs >= canonicalTs) {
    await touchHostState(ctx, host.id, canonicalRow.id, canonicalDigest, engine, canonicalLast!);
    return { ...baseResponse, status: 'upload_required', action: 'store' };
  }
  // Otherwise, host is outdated — serve the canonical auth.
  await touchHostState(ctx, host.id, canonicalRow.id, canonicalDigest, engine, canonicalLast!);
  return {
    ...baseResponse,
    status: 'outdated',
    auth: canonicalAuth,
  };
}

async function handleStore(
  _app: FastifyInstance,
  ctx: RouteContext,
  host: Host,
  payload: Record<string, unknown>,
  engine: Engine,
  runnerValidation: ReturnType<typeof createRunnerValidationService>,
  runner: ReturnType<typeof createRunnerClient>,
  versionSvc: ReturnType<typeof createVersionSnapshotService>,
  tokenUsage: ReturnType<typeof createTokenUsageService>,
): Promise<Record<string, unknown>> {
  const incoming = extractAuthPayload(payload);
  const lastRefresh = typeof incoming.last_refresh === 'string' ? incoming.last_refresh.trim() : '';
  if (!lastRefresh) throw new ValidationError('last_refresh is required', { param: 'auth.last_refresh' });
  assertReasonableLastRefresh(lastRefresh, 'auth.last_refresh');

  const withFallback = runnerValidation.ensureAuthsFallback(incoming, engine);
  const entries = runnerValidation.normalizeAuthEntries(withFallback, engine);
  const canonical = runnerValidation.canonicalizeAuthPayload(withFallback, entries, lastRefresh);
  const encoded = JSON.stringify(canonical);
  const incomingDigest = runnerValidation.calculateDigest(encoded);

  // Optional runner verification — only when configured AND not bypassed.
  let verificationState: 'pending' | 'verified' | 'failed' = 'pending';
  let runnerApplied = false;
  let canonicalToStore = canonical;
  let encodedToStore = encoded;
  let digestToStore = incomingDigest;
  let entriesToStore = entries;

  if (runner.isConfigured()) {
    const verdict = engine === ENGINE_CLAUDE ? await runner.verifyClaude({ authJson: canonical }) : await runner.verify({ authJson: canonical });
    if (verdict.ok) {
      verificationState = 'verified';
      if (verdict.updated_auth && typeof verdict.updated_auth === 'object') {
        // Runner returned a refreshed payload; replace canonical.
        const updated = verdict.updated_auth as Record<string, unknown>;
        if (typeof updated.last_refresh === 'string') {
          const withFb = runnerValidation.ensureAuthsFallback(updated, engine);
          const upEntries = runnerValidation.normalizeAuthEntries(withFb, engine);
          const upCanon = runnerValidation.canonicalizeAuthPayload(withFb, upEntries, updated.last_refresh);
          const upEnc = JSON.stringify(upCanon);
          canonicalToStore = upCanon;
          encodedToStore = upEnc;
          digestToStore = runnerValidation.calculateDigest(upEnc);
          entriesToStore = upEntries;
          runnerApplied = true;
        }
      }
    } else {
      // Runner unreachable / failed: refuse store (PHP behaviour).
      throw new ServiceUnavailableError('Runner verification failed; store is gated', 'runner_unreachable');
    }
  }

  const now = nowIso();
  const lastRefreshToStore = (canonicalToStore.last_refresh as string) ?? lastRefresh;

  // Insert payload row.
  const ins = await ctx.db.insert(authPayloads).values({
    lastRefresh: lastRefreshToStore,
    sha256: digestToStore,
    sourceHostId: host.id,
    createdAt: now,
    body: encrypt(encodedToStore, ctx.keyring),
    verificationState,
    verificationCheckedAt: verificationState === 'verified' ? now : null,
    verificationReason: null,
    engine,
  });
  const insertedRaw = ins[0] as { insertId?: number | bigint } | undefined;
  const payloadId = insertedRaw?.insertId !== undefined ? Number(insertedRaw.insertId) : 0;

  // Insert per-entry rows for auths{}.
  for (const e of entriesToStore) {
    await ctx.db.insert(authEntries).values({
      payloadId,
      target: e.target,
      token: encrypt(e.token, ctx.keyring),
      tokenType: e.tokenType ?? undefined,
      organization: e.organization ?? undefined,
      project: e.project ?? undefined,
      apiBase: e.apiBase ?? undefined,
      meta: e.meta ?? undefined,
      createdAt: now,
    });
  }

  // Remember digest for this host.
  await ctx.db.insert(hostAuthDigests).values({
    hostId: host.id,
    digest: digestToStore,
    lastSeen: now,
    createdAt: now,
    engine,
  });

  await touchHostState(ctx, host.id, payloadId, digestToStore, engine, lastRefreshToStore);

  await ctx.db
    .update(hostsTable)
    .set({ apiCalls: (Number(host.apiCalls ?? 0) + 1), updatedAt: now })
    .where(eq(hostsTable.id, host.id));

  await ctx.db.insert(logsTable).values({
    hostId: host.id,
    action: 'auth.store',
    details: JSON.stringify({ status: 'updated', engine, digest: digestToStore }),
    createdAt: now,
  });

  const totals = await tokenUsage.totalsForMonth(host.id);
  const summary = withLegacyShellWrapperTransition(
    await versionSvc.summary(engine),
    payload.wrapper_version,
    engine,
  );

  return {
    status: 'updated',
    auth: canonicalToStore,
    canonical_last_refresh: lastRefreshToStore,
    canonical_digest: digestToStore,
    verification_state: verificationState,
    pending_payload_id: payloadId,
    api_calls: Number(host.apiCalls ?? 0) + 1,
    token_usage_month: totals,
    versions: summary,
    host: buildHostPayload(host),
    runner_applied: runnerApplied,
    engine,
  };
}

async function touchHostState(
  ctx: RouteContext,
  hostId: number,
  payloadId: number,
  digest: string,
  engine: Engine,
  lastRefresh: string,
): Promise<void> {
  const now = nowIso();
  const existing = await ctx.db
    .select()
    .from(hostAuthStates)
    .where(and(eq(hostAuthStates.hostId, hostId), eq(hostAuthStates.engine, engine)))
    .limit(1);
  if (existing[0]) {
    await ctx.db
      .update(hostAuthStates)
      .set({ payloadId, seenDigest: digest, seenAt: now })
      .where(and(eq(hostAuthStates.hostId, hostId), eq(hostAuthStates.engine, engine)));
  } else {
    await ctx.db.insert(hostAuthStates).values({ hostId, payloadId, seenDigest: digest, seenAt: now, engine });
  }
  await ctx.db
    .update(hostsTable)
    .set(
      engine === ENGINE_CLAUDE
        ? { claudeLastRefresh: lastRefresh, claudeAuthDigest: digest, updatedAt: now }
        : { lastRefresh, authDigest: digest, updatedAt: now },
    )
    .where(eq(hostsTable.id, hostId));
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function readPayload(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function normalizeCommand(value: unknown): 'retrieve' | 'store' {
  if (typeof value !== 'string') return 'retrieve';
  const v = value.toLowerCase().trim();
  if (v === '' || v === 'retrieve') return 'retrieve';
  if (v === 'store') return 'store';
  throw new ValidationError('command must be "retrieve" or "store"', { param: 'command' });
}

function extractDigest(payload: Record<string, unknown>, required: boolean): string | null {
  const candidates = [payload.digest, payload.auth_digest, payload.auth_sha];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const trimmed = c.trim().toLowerCase();
    if (!trimmed) continue;
    if (!/^[a-f0-9]{64}$/.test(trimmed)) {
      throw new ValidationError('digest must be a 64-character hex sha256 value', { param: 'digest' });
    }
    return trimmed;
  }
  if (required) throw new ValidationError('digest is required', { param: 'digest' });
  return null;
}

function assertReasonableLastRefresh(value: string, field: string): void {
  if (!isRfc3339(value)) throw new ValidationError(`${field} must be an RFC3339 timestamp`, { param: field });
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) throw new ValidationError(`${field} must be an RFC3339 timestamp`, { param: field });
  if (ts < MIN_REFRESH_EPOCH_MS) throw new ValidationError(`${field} is implausibly old`, { param: field });
  if (ts > Date.now() + MAX_FUTURE_SKEW_MS) throw new ValidationError(`${field} is in the future`, { param: field });
}

function extractHostUserInput(payload: Record<string, unknown>): { username: string | null; hostname: string | null } {
  const sync = (payload.host_user ?? payload.sync_host_user ?? {}) as Record<string, unknown>;
  const username = typeof sync.username === 'string' ? sync.username : typeof payload.username === 'string' ? (payload.username as string) : null;
  const hostname = typeof sync.hostname === 'string' ? sync.hostname : typeof payload.hostname === 'string' ? (payload.hostname as string) : null;
  return { username, hostname };
}

function normalizeBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
  }
  return null;
}

function uniqueNonEmpty(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) if (v && !seen.has(v)) (seen.add(v), out.push(v));
  return out;
}

async function assertApiNotDisabled(versions: ReturnType<typeof createVersionSnapshotService>): Promise<void> {
  if (await versions.flag('api_disabled', false)) {
    throw new ApiError('API disabled by administrator', { status: 503, code: 'api_disabled' });
  }
}

async function maybeEnforceInsecure(
  insecure: ReturnType<typeof createInsecureWindowService>,
  host: Host,
  command: string,
): Promise<Host> {
  return host.secure === 1 ? host : insecure.enforce(host, command);
}

function buildHostPayload(host: Host): Record<string, unknown> {
  return {
    fqdn: host.fqdn,
    status: host.status,
    last_refresh: host.lastRefresh ?? null,
    claude_last_refresh: host.claudeLastRefresh ?? null,
    updated_at: host.updatedAt,
    expires_at: host.expiresAt ?? null,
    client_version: host.clientVersion ?? null,
    client_version_override: host.clientVersionOverride ?? null,
    wrapper_version: host.wrapperVersion ?? null,
    api_calls: Number(host.apiCalls ?? 0),
    allow_roaming_ips: host.allowRoamingIps === 1,
    secure: host.secure === 1,
    vip: host.vip === 1,
    insecure_enabled_until: host.insecureEnabledUntil ?? null,
    insecure_grace_until: host.insecureGraceUntil ?? null,
    insecure_window_minutes: host.insecureWindowMinutes ?? null,
    lane_preference: host.lanePreference ?? null,
    model_override: host.modelOverride ?? null,
    reasoning_effort_override: host.reasoningEffortOverride ?? null,
    auto_update_override: host.autoUpdateOverride === null || host.autoUpdateOverride === undefined ? null : host.autoUpdateOverride === 1,
    last_cron_check: host.lastCronCheck ?? null,
    engines: host.engines,
    claude_client_version: host.claudeClientVersion ?? null,
    claude_client_version_override: host.claudeClientVersionOverride ?? null,
    claude_wrapper_version: host.claudeWrapperVersion ?? null,
    claude_auth_digest: host.claudeAuthDigest ?? null,
    claude_model_override: host.claudeModelOverride ?? null,
    claude_reasoning_effort_override: host.claudeReasoningEffortOverride ?? null,
  };
}

// Engine consts used in switch arms for clarity.
void ENGINE_CODEX;
// Reference desc to silence unused-imports warning when callers don't use it.
void desc;

async function readQuotaLimitPercent(
  versionSvc: ReturnType<typeof createVersionSnapshotService>,
): Promise<number | null> {
  const raw = await versionSvc.setting('quota_limit_percent');
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(50, Math.min(100, Math.round(n)));
}

async function readChatgptSnapshot(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const svc = new ChatGptUsageService(ctx.db);
    const row = await svc.latest();
    if (!row) return null;
    return {
      status: row.status ?? null,
      plan_type: row.planType ?? null,
      primary_used_percent: row.primaryUsedPercent ?? null,
      primary_limit_seconds: row.primaryLimitSeconds ?? null,
      primary_reset_after_seconds: row.primaryResetAfterSeconds ?? null,
      primary_reset_at: row.primaryResetAt ?? null,
      secondary_used_percent: row.secondaryUsedPercent ?? null,
      secondary_limit_seconds: row.secondaryLimitSeconds ?? null,
      secondary_reset_after_seconds: row.secondaryResetAfterSeconds ?? null,
      secondary_reset_at: row.secondaryResetAt ?? null,
      spark_limit_name: row.sparkLimitName ?? null,
      spark_metered_feature: row.sparkMeteredFeature ?? null,
      spark_primary_used_percent: row.sparkPrimaryUsedPercent ?? null,
      spark_primary_limit_seconds: row.sparkPrimaryLimitSeconds ?? null,
      spark_primary_reset_after_seconds: row.sparkPrimaryResetAfterSeconds ?? null,
      spark_primary_reset_at: row.sparkPrimaryResetAt ?? null,
      spark_secondary_used_percent: row.sparkSecondaryUsedPercent ?? null,
      spark_secondary_limit_seconds: row.sparkSecondaryLimitSeconds ?? null,
      spark_secondary_reset_after_seconds: row.sparkSecondaryResetAfterSeconds ?? null,
      spark_secondary_reset_at: row.sparkSecondaryResetAt ?? null,
      fetched_at: row.fetchedAt ?? null,
    };
  } catch {
    return null;
  }
}

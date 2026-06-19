import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import {
  hostAuthDigests,
  hosts as hostsTable,
  logs as logsTable,
  type Host,
} from '../../db/schema.js';
import type { RouteContext } from '../index.js';
import { ApiError, ValidationError } from '../../http/errors.js';
import { nowIso } from '../../util/timestamp.js';
import { parseEngine, type Engine, ENGINE_CLAUDE, ENGINE_CODEX } from '../../util/engine.js';
import { wsPublisher } from '../../ws/publisher.js';

import { createAuthFailureTracker } from '../../services/auth-failure-tracker.js';
import { ClientVersionsService } from '../../services/client-versions.js';
import { createHostAuthService } from '../../services/host-auth.js';
import { createInsecureWindowService } from '../../services/insecure-window.js';
import { SettingsService } from '../../services/settings.js';
import { createVersionSnapshotService } from '../../services/version-snapshot.js';
import { createHostSyncService } from '../../services/host-sync.js';
import { HostAgentsService } from '../../services/host-agents.js';
import { HostClaudeArtifactsService, type ArtifactDigestMap } from '../../services/host-claude-artifacts.js';
import { HostSkillsService } from '../../services/host-skills.js';
import { normalizeKind } from '../../services/claude-frontmatter.js';
import { HostSessionsService } from '../../services/host-sessions.js';
import {
  createRunnerValidationService,
  extractAuthPayload,
} from '../../services/runner-validation.js';
import { createRunnerClient } from '../../services/runner-client.js';
import {
  assertReasonableLastRefresh,
  createCanonicalAuthStoreService,
  touchHostAuthFields,
  touchHostAuthState,
} from '../../services/canonical-auth-store.js';
import { withLegacyShellWrapperTransition } from '../../services/wrapper-transition.js';
import { ChatGptUsageService, normalizeChatGptUsageSnapshot } from '../../services/chatgpt-usage.js';
import { assertHostEngineEnabled, hostEnginesList } from '../../services/host-engine-policy.js';

/**
 * Registers the wrapper-facing /auth (+ /sync/*) routes. The legacy PHP
 * AuthService is split across:
 *   - host-auth         (validate API key → host row)
 *   - insecure-window   (sliding window + grace + approval)
 *   - runner-validation (canonical payload + digest)
 *   - host-sync         (sync envelope content)
 *   - version-snapshot  (versions block)
 *
 * /auth is the wrapper's "what's the latest canonical auth blob" probe;
 * `command=retrieve` (default) compares the host's submitted digest to the
 * canonical one; `command=store` accepts an upload and (if the runner is
 * configured) verifies it before persisting.
 */
export async function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const failures = createAuthFailureTracker(app);
  const insecure = createInsecureWindowService({ db: ctx.db, env: ctx.env });
  const hostAuth = createHostAuthService({ db: ctx.db, failures, env: ctx.env, insecure });
  const clientVersions = new ClientVersionsService(new SettingsService(ctx.db), app.log);
  const versions = createVersionSnapshotService({
    db: ctx.db,
    installationId: ctx.env.INSTALLATION_ID ?? null,
    refreshLatestClientVersion: async (engine) => {
      await clientVersions.availableClientVersion(false, engine);
    },
  });
  const syncService = createHostSyncService({ db: ctx.db, versions });
  const agentsService = new HostAgentsService(ctx.db, {
    publicBaseUrl: ctx.env.PUBLIC_BASE_URL ?? null,
    keyring: ctx.keyring,
  });
  const sessionsService = new HostSessionsService(ctx.db);
  const claudeArtifactsService = new HostClaudeArtifactsService(ctx.db);
  const skillsService = new HostSkillsService(ctx.db);
  const runnerValidation = createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring });
  const runner = createRunnerClient({ env: ctx.env });
  const authStore = createCanonicalAuthStoreService({
    db: ctx.db,
    keyring: ctx.keyring,
    runnerValidation,
    runner,
  });

  // POST /auth — primary wrapper probe.
  app.post('/auth', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = parseEngine(payload.engine);
    assertHostEngineEnabled(host, engine);
    const command = normalizeCommand(payload.command);
    const enforcedHost = await maybeEnforceInsecure(insecure, host, command);

    if (command === 'retrieve') {
      return handleRetrieve(app, ctx, enforcedHost, payload, engine, runnerValidation, versions, authStore);
    }
    return handleStore(app, ctx, enforcedHost, payload, engine, authStore, runnerValidation, versions);
  });

  // DELETE /auth — host uninstall.
  app.delete('/auth', async (req) => {
    const host = await hostAuth.authenticate(req);
    const force = (req.query as { force?: string })?.force === '1';
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
    assertHostEngineEnabled(host, engine);
    const enforced = await maybeEnforceInsecure(insecure, host, 'retrieve');

    const userInput = extractHostUserInput(payload);
    const users = await syncService.recordHostUser(enforced.id, userInput.username, userInput.hostname);
    const out = await syncService.collect({ host: enforced, engine, bootstrap: false });
    out.versions = withLegacyShellWrapperTransition(out.versions, payload.wrapper_version, engine);
    out.host_users = users;

    const includeAuth = normalizeBoolean(payload.include_auth) !== false;
    if (includeAuth) {
      const authResult = await handleRetrieve(app, ctx, enforced, payload, engine, runnerValidation, versions, authStore);
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
    assertHostEngineEnabled(host, engine);
    const enforced = await maybeEnforceInsecure(insecure, host, 'retrieve');

    const userInput = extractHostUserInput(payload);
    const users = await syncService.recordHostUser(enforced.id, userInput.username, userInput.hostname);
    const out = await syncService.collect({ host: enforced, engine, bootstrap: true });
    out.versions = withLegacyShellWrapperTransition(out.versions, payload.wrapper_version, engine);
    out.host_users = users;

    const includeAuth = normalizeBoolean(payload.include_auth) !== false;
    if (includeAuth) {
      const authResult = await handleBootstrapAuth(
        app,
        ctx,
        enforced,
        payload,
        engine,
        runnerValidation,
        authStore,
        versions,
      );
      out.auth = authResult;
      const status = ((authResult as { status?: string }).status ?? '').toLowerCase();
      if (status !== 'valid') {
        out.reasons.push(`auth_${status !== '' ? status : 'unknown'}`);
      }
      if (status === 'updated') out.reasons.push('auth_stored');
    }

    // Inline the agents + client-config bodies so the wrapper's bundle path can
    // refresh them in the same round-trip. The wrapper sends the local file
    // digests as `agents`/`config`; the services return `status: 'unchanged'`
    // when they match (no `content` field), and `status: 'updated'` with the
    // full body otherwise — `resourceContent()` on the wrapper unwraps either.
    const agentsDigest = typeof payload.agents === 'string' ? (payload.agents as string) : null;
    const configDigest = typeof payload.config === 'string' ? (payload.config as string) : null;
    out.agents = await agentsService.retrieve(agentsDigest, enforced, engine);
    out.config = await agentsService.retrieveConfig(configDigest, enforced, engine, {
      home: typeof payload.home === 'string' ? payload.home : null,
      username: typeof payload.username === 'string' ? payload.username : null,
    });

    // Claude-native collections (subagents / commands / output-styles). Only
    // ever bundled for Claude hosts; the wrapper sends per-item digests under
    // `artifacts` so unchanged items come back without content. Returns the
    // COMPLETE live set so the wrapper can reconcile deletions against its
    // on-disk manifest. Older/codex hosts simply never see this block.
    if (engine === ENGINE_CLAUDE) {
      out.claude_artifacts = await claudeArtifactsService.bundle(enforced, engine, readArtifactDigests(payload));
      out.claude_settings = await agentsService.retrieveClaudeSettings(enforced, {
        home: typeof payload.home === 'string' ? payload.home : null,
        username: typeof payload.username === 'string' ? payload.username : null,
      });
      // On-disk skills: Claude Code can't read skills over MCP (unlike codex), so
      // the fleet's shared skills are delivered as native ~/.claude/skills/<slug>/
      // SKILL.md files. Complete live set; content omitted on rendered-sha match.
      out.claude_skills = await skillsService.bundle(enforced, engine, readSkillDigests(payload));
    }

    // Fleet-wide session counts for the cdx boot-screen "sessions" block.
    // Cheap indexed COUNT queries against the existing logs table; the
    // wrapper renders them next to the quota bars (or skips gracefully on
    // older servers that don't return this block).
    out.sessions = await sessionsService.fleetCounts();

    out.reasons = uniqueNonEmpty(out.reasons);
    out.status = out.reasons.length === 0 ? 'ok' : 'update';
    return out;
  });
}

/**
 * Reads the wrapper's on-disk artifact digest map from a bootstrap payload.
 * Tolerant of kind-key spelling (`agents`/`subagent`/…) via normalizeKind; any
 * unrecognized key is skipped. Shape: `{ <kind>: { <slug>: <sha256> } }`.
 */
/**
 * Per-slug skill digests the wrapper sends so the server can omit `content` for
 * unchanged skills. Deliberately separate from readArtifactDigests: skills are
 * NOT an artifact kind (normalizeKind('skill') throws), so routing them through
 * that path would silently drop them and break If-None-Match. Accepts either a
 * top-level `skills` map or `artifacts.skill`.
 */
function readSkillDigests(payload: Record<string, unknown>): Record<string, string> {
  const artifacts = payload['artifacts'];
  const fromArtifacts =
    artifacts && typeof artifacts === 'object' && !Array.isArray(artifacts)
      ? (artifacts as Record<string, unknown>)['skill']
      : undefined;
  const raw = payload['skills'] ?? fromArtifacts;
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [slug, sha] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof sha === 'string') out[slug] = sha;
  }
  return out;
}

function readArtifactDigests(payload: Record<string, unknown>): ArtifactDigestMap {
  const raw = payload['artifacts'];
  const out: ArtifactDigestMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [rawKind, value] of Object.entries(raw as Record<string, unknown>)) {
    let kind;
    try {
      kind = normalizeKind(rawKind);
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const map: Record<string, string> = {};
    for (const [slug, sha] of Object.entries(value as Record<string, unknown>)) {
      if (typeof sha === 'string') map[slug] = sha;
    }
    out[kind] = map;
  }
  return out;
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
  authStore: ReturnType<typeof createCanonicalAuthStoreService>,
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
  const baseResponse: Record<string, unknown> = {
    canonical_last_refresh: canonicalLast,
    canonical_digest: canonicalDigest,
    host: buildHostPayload(host),
    api_calls: Number(host.apiCalls ?? 0) + 1,
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

  // Launch-gate proof: before reporting any green status, ensure the canonical
  // auth the host is about to launch with actually works. TTL-bounded so the
  // common path stays probe-free. Runs for BOTH engines — codex's rotated
  // ChatGPT refresh tokens fail with "refresh token already used" exactly the
  // way Claude's stale OAuth surfaces a 401 / "Please run /login" inside the
  // client; serving either unverified drops the user into a raw failure.
  let servedAuth = canonicalAuth!;
  let servedDigest = canonicalDigest;
  let servedLast = canonicalLast!;
  {
    const ttlSeconds = Number(ctx.env.AUTH_RUNNER_VERIFY_TTL_SECONDS ?? 900);
    const verdict = await authStore.ensureServedVerification({
      engine,
      hostId: host.id,
      row: {
        id: canonicalRow.id,
        verificationState: canonicalRow.verificationState,
        verificationCheckedAt: canonicalRow.verificationCheckedAt,
      },
      auth: canonicalAuth!,
      digest: canonicalDigest,
      lastRefresh: canonicalLast!,
      ttlSeconds,
    });
    baseResponse.verification_state = verdict.state;
    if (verdict.reason) baseResponse.verification_reason = verdict.reason;
    if (verdict.state === 'failed') {
      // Definitively bad credentials. Do not serve the known-bad blob; surface
      // verification_state so the wrapper refuses launch with an actionable
      // re-login message instead of dropping the user into a raw 401.
      await touchHostAuthState(ctx.db, host.id, canonicalRow.id, servedDigest, engine);
      return { ...baseResponse, status: 'outdated' };
    }
    servedAuth = verdict.auth;
    servedDigest = verdict.digest;
    servedLast = verdict.lastRefresh;
    // Keep the advertised canonical metadata consistent with a refreshed blob.
    baseResponse.canonical_digest = servedDigest;
    baseResponse.canonical_last_refresh = servedLast;
  }

  const incomingTs = incomingLast ? Date.parse(incomingLast) : 0;
  const canonicalTs = servedLast ? Date.parse(servedLast) : 0;
  const matchesCanonical = providedDigest && servedDigest && providedDigest === servedDigest;

  if (matchesCanonical) {
    await touchHostAuthState(ctx.db, host.id, canonicalRow.id, servedDigest, engine);
    await touchHostAuthFields(ctx.db, host.id, servedLast, servedDigest, engine);
    return { ...baseResponse, status: 'valid' };
  }
  if (incomingTs >= canonicalTs) {
    await touchHostAuthState(ctx.db, host.id, canonicalRow.id, servedDigest, engine);
    await touchHostAuthFields(ctx.db, host.id, servedLast, servedDigest, engine);
    return { ...baseResponse, status: 'upload_required', action: 'store' };
  }
  // Otherwise, host is outdated — serve the (verified) canonical auth.
  await touchHostAuthState(ctx.db, host.id, canonicalRow.id, servedDigest, engine);
  await touchHostAuthFields(ctx.db, host.id, servedLast, servedDigest, engine);
  return {
    ...baseResponse,
    status: 'outdated',
    auth: servedAuth,
  };
}

async function buildRetrieveBaseResponse(
  ctx: RouteContext,
  host: Host,
  payload: Record<string, unknown>,
  engine: Engine,
  versionSvc: ReturnType<typeof createVersionSnapshotService>,
): Promise<Record<string, unknown>> {
  await ctx.db
    .update(hostsTable)
    .set({ apiCalls: (Number(host.apiCalls ?? 0) + 1), updatedAt: nowIso() })
    .where(eq(hostsTable.id, host.id));

  const versions = withLegacyShellWrapperTransition(
    await versionSvc.summary(engine),
    payload.wrapper_version,
    engine,
  );
  const baseResponse: Record<string, unknown> = {
    host: buildHostPayload(host),
    api_calls: Number(host.apiCalls ?? 0) + 1,
    versions,
    quota_hard_fail: host.vip === 1 ? false : await versionSvc.flag('quota_hard_fail', true),
    quota_limit_percent: await readQuotaLimitPercent(versionSvc),
    cdx_silent: versions.cdx_silent,
    engine,
  };
  if (engine === ENGINE_CODEX) {
    baseResponse.chatgpt = await readChatgptSnapshot(ctx);
  }
  return baseResponse;
}

async function handleBootstrapAuth(
  app: FastifyInstance,
  ctx: RouteContext,
  host: Host,
  payload: Record<string, unknown>,
  engine: Engine,
  runnerValidation: ReturnType<typeof createRunnerValidationService>,
  authStore: ReturnType<typeof createCanonicalAuthStoreService>,
  versionSvc: ReturnType<typeof createVersionSnapshotService>,
): Promise<Record<string, unknown>> {
  const candidate = readAuthCandidate(payload);
  if (!candidate) return handleRetrieve(app, ctx, host, payload, engine, runnerValidation, versionSvc, authStore);

  const canonicalRow = await runnerValidation.resolveCanonicalPayload(engine);
  const validated = runnerValidation.validateCanonicalPayload(canonicalRow);
  const canonicalDigest = validated?.digest ?? null;
  const canonicalLast = validated?.last_refresh ?? null;
  const candidateLast = typeof candidate.last_refresh === 'string' ? candidate.last_refresh.trim() : '';
  if (candidateLast) assertReasonableLastRefresh(candidateLast, 'auth_candidate.last_refresh');

  if (canonicalRow && canonicalDigest && canonicalLast && validated) {
    const candidateDigest = canonicalizedCandidateDigest(candidate, candidateLast || canonicalLast, engine, runnerValidation);
    if (candidateDigest === canonicalDigest) {
      // Candidate already matches canonical: this is the common warm-launch
      // path. Prove the shared blob still works (TTL-bounded) before reporting
      // green, mirroring handleRetrieve — otherwise a stale-but-matching token
      // sails through to a 401 inside Claude (or a "refresh token already used"
      // failure inside codex).
      const baseResponse = await buildRetrieveBaseResponse(ctx, host, payload, engine, versionSvc);
      let servedDigest = canonicalDigest;
      let servedLast = canonicalLast;
      {
        const ttlSeconds = Number(ctx.env.AUTH_RUNNER_VERIFY_TTL_SECONDS ?? 900);
        const verdict = await authStore.ensureServedVerification({
          engine,
          hostId: host.id,
          row: {
            id: canonicalRow.id,
            verificationState: canonicalRow.verificationState,
            verificationCheckedAt: canonicalRow.verificationCheckedAt,
          },
          auth: validated.auth,
          digest: canonicalDigest,
          lastRefresh: canonicalLast,
          ttlSeconds,
        });
        baseResponse.verification_state = verdict.state;
        if (verdict.reason) baseResponse.verification_reason = verdict.reason;
        if (verdict.state === 'failed') {
          await touchHostAuthState(ctx.db, host.id, canonicalRow.id, servedDigest, engine);
          return { ...baseResponse, canonical_last_refresh: servedLast, canonical_digest: servedDigest, status: 'outdated' };
        }
        servedDigest = verdict.digest;
        servedLast = verdict.lastRefresh;
        // A refresh during verification means the candidate no longer matches:
        // serve the refreshed blob so the host upgrades to live credentials.
        if (verdict.refreshed) {
          await touchHostAuthState(ctx.db, host.id, canonicalRow.id, servedDigest, engine);
          await touchHostAuthFields(ctx.db, host.id, servedLast, servedDigest, engine);
          return { ...baseResponse, canonical_last_refresh: servedLast, canonical_digest: servedDigest, status: 'outdated', auth: verdict.auth };
        }
      }
      await touchHostAuthState(ctx.db, host.id, canonicalRow.id, servedDigest, engine);
      await touchHostAuthFields(ctx.db, host.id, servedLast, servedDigest, engine);
      return { ...baseResponse, canonical_last_refresh: servedLast, canonical_digest: servedDigest, status: 'valid' };
    }
    if (candidateLast && Date.parse(candidateLast) < Date.parse(canonicalLast)) {
      return handleRetrieve(app, ctx, host, payload, engine, runnerValidation, versionSvc, authStore);
    }
  }

  try {
    const stored = await authStore.storeCandidate({
      auth: candidate,
      engine,
      sourceHostId: host.id,
      requireLastRefresh: false,
      logAction: 'auth.store',
      logDetails: { source: 'sync.bootstrap' },
    });
    const baseResponse = await buildRetrieveBaseResponse(ctx, host, payload, engine, versionSvc);
    return { ...baseResponse, ...stored };
  } catch (err) {
    app.log.warn({ err, host: host.fqdn, engine }, 'bootstrap auth_candidate store failed; falling back to retrieve');
    return handleRetrieve(app, ctx, host, payload, engine, runnerValidation, versionSvc, authStore);
  }
}

function readAuthCandidate(payload: Record<string, unknown>): Record<string, unknown> | null {
  const candidate = payload.auth_candidate;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  return candidate as Record<string, unknown>;
}

function canonicalizedCandidateDigest(
  candidate: Record<string, unknown>,
  lastRefresh: string,
  engine: Engine,
  runnerValidation: ReturnType<typeof createRunnerValidationService>,
): string | null {
  const withFallback = runnerValidation.ensureAuthsFallback(candidate, engine);
  const entries = runnerValidation.normalizeAuthEntries(withFallback, engine);
  if (entries.length === 0) return null;
  const canonical = runnerValidation.canonicalizeAuthPayload(withFallback, entries, lastRefresh);
  return runnerValidation.calculateDigest(JSON.stringify(canonical));
}

async function handleStore(
  app: FastifyInstance,
  ctx: RouteContext,
  host: Host,
  payload: Record<string, unknown>,
  engine: Engine,
  authStore: ReturnType<typeof createCanonicalAuthStoreService>,
  runnerValidation: ReturnType<typeof createRunnerValidationService>,
  versionSvc: ReturnType<typeof createVersionSnapshotService>,
): Promise<Record<string, unknown>> {
  const incoming = extractAuthPayload(payload);
  let stored;
  try {
    stored = await authStore.storeCandidate({
      auth: incoming,
      engine,
      sourceHostId: host.id,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });
  } catch (err) {
    app.log.warn({ err, host: host.fqdn, engine }, 'auth store failed');
    throw err;
  }
  const now = nowIso();
  await ctx.db
    .update(hostsTable)
    .set({ apiCalls: (Number(host.apiCalls ?? 0) + 1), updatedAt: now })
    .where(eq(hostsTable.id, host.id));

  const summary = withLegacyShellWrapperTransition(
    await versionSvc.summary(engine),
    payload.wrapper_version,
    engine,
  );

  return {
    ...stored,
    api_calls: Number(host.apiCalls ?? 0) + 1,
    versions: summary,
    host: buildHostPayload(host),
  };
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
  for (const v of list) { if (v && !seen.has(v)) { seen.add(v); out.push(v); } }
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
    browseros_mcp_enabled: host.browserosMcpEnabled === 1,
    lane_preference: host.lanePreference ?? null,
    model_override: host.modelOverride ?? null,
    reasoning_effort_override: host.reasoningEffortOverride ?? null,
    auto_update_override: host.autoUpdateOverride === null || host.autoUpdateOverride === undefined ? null : host.autoUpdateOverride === 1,
    last_cron_check: host.lastCronCheck ?? null,
    engines: host.engines,
    engines_list: hostEnginesList(host.engines),
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
    const svc = new ChatGptUsageService(ctx.db, undefined, { env: ctx.env, keyring: ctx.keyring });
    const row = await svc.latest();
    if (!row) return null;
    return normalizeChatGptUsageSnapshot(row);
  } catch {
    return null;
  }
}

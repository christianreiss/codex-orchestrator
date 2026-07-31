import type { FastifyInstance, FastifyRequest } from 'fastify';
import { join, resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import {
  hostAuthDigests,
  hostAuthStates,
  hosts as hostsTable,
  installTokens,
  logs as logsTable,
  type Host,
} from '../../db/schema.js';
import type { RouteContext } from '../index.js';
import { ApiError, ValidationError } from '../../http/errors.js';
import { compareRfc3339, nowIso } from '../../util/timestamp.js';
import { isEngine, type Engine, ENGINE_CLAUDE, ENGINE_CODEX } from '../../util/engine.js';
import { wsPublisher } from '../../ws/publisher.js';

import { createAuthFailureTracker } from '../../services/auth-failure-tracker.js';
import { ClientVersionsService } from '../../services/client-versions.js';
import { createHostAuthService } from '../../services/host-auth.js';
import { createInsecureWindowService } from '../../services/insecure-window.js';
import { SettingsService } from '../../services/settings.js';
import {
  createVersionSnapshotService,
  type VersionSnapshot,
} from '../../services/version-snapshot.js';
import { createHostSyncService } from '../../services/host-sync.js';
import { HostAgentsService } from '../../services/host-agents.js';
import { HostClaudeArtifactsService, type ArtifactDigestMap } from '../../services/host-claude-artifacts.js';
import { HostSkillsService } from '../../services/host-skills.js';
import { normalizeKind } from '../../services/claude-frontmatter.js';
import { HostSessionsService } from '../../services/host-sessions.js';
import { createRunnerValidationService, extractAuthPayload } from '../../services/runner-validation.js';
import { createRunnerClient } from '../../services/runner-client.js';
import {
  assertReasonableLastRefresh,
  createCanonicalAuthStoreService,
  touchHostAuthFields,
  touchHostAuthState,
} from '../../services/canonical-auth-store.js';
import { createWrapperBinRegistry } from '../../services/wrapper-bin-registry.js';
import { projectWrapperVersionSnapshot } from '../../services/wrapper-version-projection.js';
import { ChatGptUsageService, normalizeChatGptUsageSnapshot } from '../../services/chatgpt-usage.js';
import { assertHostEngineEnabled, hostEnginesList } from '../../services/host-engine-policy.js';
import { inspectCredential } from '../../services/auth-generation.js';
import { resolveAuthRequestEngine } from './engine-resolution.js';
import { resolveWrapperPlatform } from '../../util/wrapper-platform.js';
import { suspendAgentMessagingRuntimeLocked } from '../../services/agent-messaging.js';

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
  const binRoot = ctx.env.DATA_ROOT
    ? join(ctx.env.DATA_ROOT, 'wrapper', 'v2', 'bin')
    : resolve(import.meta.dirname, '..', '..', '..', '..', 'storage', 'wrapper', 'v2', 'bin');
  const binaries = createWrapperBinRegistry({ binRoot });
  const requestVersions = (req: FastifyRequest): RequestVersionProjector => {
    const platform = resolveWrapperPlatform(req.headers);
    const publicBaseUrl = resolvePublicBaseUrl(req, ctx.env.PUBLIC_BASE_URL);
    return async (engine, submittedWrapperVersion) =>
      projectWrapperVersionSnapshot({
        snapshot: await versions.summary(engine),
        engine,
        submittedWrapperVersion,
        platform,
        publicBaseUrl,
        binaries,
      });
  };
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
    const engine = resolveAuthRequestEngine(req, payload);
    assertHostEngineEnabled(host, engine);
    const command = normalizeCommand(payload.command);
    const enforcedHost = await maybeEnforceInsecure(insecure, host, command);
    const projectedVersions = requestVersions(req);

    if (command === 'retrieve') {
      return handleRetrieve(
        app,
        ctx,
        enforcedHost,
        payload,
        engine,
        runnerValidation,
        projectedVersions,
        authStore,
      );
    }
    return handleStore(
      app,
      ctx,
      enforcedHost,
      payload,
      engine,
      authStore,
      runnerValidation,
      projectedVersions,
    );
  });

  // DELETE /auth — host uninstall.
  app.delete('/auth', async (req) => {
    const host = await hostAuth.authenticate(req);
    const query = req.query as { force?: string; engine?: string };
    const force = query.force === '1';
    const explicitEngine = typeof query.engine === 'string' && query.engine.trim() !== '';
    if (explicitEngine) {
      const engine = query.engine!.trim().toLowerCase();
      if (!isEngine(engine)) {
        throw new ValidationError('engine must be "codex" or "claude"', { param: 'engine' });
      }
      assertHostEngineEnabled(host, engine);
      const remaining = hostEnginesList(host.engines).filter((item) => item !== engine);
      if (remaining.length > 0) {
        const now = nowIso();
        await ctx.db.transaction(async (tx) => {
          await suspendAgentMessagingRuntimeLocked(tx, host.id, 'engine_disabled', [engine]);
          await tx.insert(logsTable).values({
            hostId: host.id,
            action: 'host.engine.delete',
            details: JSON.stringify({ fqdn: host.fqdn, engine, initiator: 'host_api', force }),
            createdAt: now,
          });
          await tx
            .delete(hostAuthDigests)
            .where(and(eq(hostAuthDigests.hostId, host.id), eq(hostAuthDigests.engine, engine)));
          await tx
            .delete(hostAuthStates)
            .where(and(eq(hostAuthStates.hostId, host.id), eq(hostAuthStates.engine, engine)));
          // A pending installer embeds the shared host API key. Revoke any
          // installer for the removed engine so an old one-time URL cannot be
          // used after that engine has been uninstalled.
          await tx
            .delete(installTokens)
            .where(and(eq(installTokens.hostId, host.id), eq(installTokens.engine, engine)));
          await tx
            .update(hostsTable)
            .set({
              engines: remaining.join(','),
              ...(engine === ENGINE_CLAUDE
                ? {
                    claudeAuthDigest: null,
                    claudeLastRefresh: null,
                    claudeClientVersion: null,
                    claudeClientVersionOverride: null,
                    claudeWrapperVersion: null,
                    claudeModelOverride: null,
                    claudeReasoningEffortOverride: null,
                  }
                : {
                    authDigest: null,
                    lastRefresh: null,
                    clientVersion: null,
                    clientVersionOverride: null,
                    wrapperVersion: null,
                    lanePreference: null,
                    modelOverride: null,
                    reasoningEffortOverride: null,
                  }),
              updatedAt: now,
            })
            .where(eq(hostsTable.id, host.id));
        });
        wsPublisher.publish('host.updated', { id: host.id, fqdn: host.fqdn, engine });
        return { deleted_engine: engine, remaining_engines: remaining };
      }
    }

    // Legacy requests without `engine` (and an explicit uninstall of the last
    // enabled engine) retain the whole-host de-registration behaviour.
    await ctx.db.transaction(async (tx) => {
      await suspendAgentMessagingRuntimeLocked(tx, host.id, 'host_inactive');
      // Keep the audit row independent of host FK policy: the host identity is
      // preserved in details while the nullable FK is deliberately unset.
      await tx.insert(logsTable).values({
        hostId: null,
        action: 'host.delete',
        details: JSON.stringify({ host_id: host.id, fqdn: host.fqdn, initiator: 'host_api', force }),
        createdAt: nowIso(),
      });
      await tx.delete(hostAuthDigests).where(eq(hostAuthDigests.hostId, host.id));
      await tx.delete(hostAuthStates).where(eq(hostAuthStates.hostId, host.id));
      await tx.delete(hostsTable).where(eq(hostsTable.id, host.id));
    });
    wsPublisher.publish('host.deleted', { id: host.id, fqdn: host.fqdn });
    return { deleted: host.fqdn };
  });

  // POST /sync/status — periodic check-in.
  app.post('/sync/status', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = resolveAuthRequestEngine(req, payload);
    assertHostEngineEnabled(host, engine);
    const enforced = await maybeEnforceInsecure(insecure, host, 'retrieve');
    const projectedVersions = requestVersions(req);

    const userInput = extractHostUserInput(payload);
    const users = await syncService.recordHostUser(enforced.id, userInput.username, userInput.hostname);
    const out = await syncService.collect({ host: enforced, engine, bootstrap: false, users });
    out.versions = await projectedVersions(engine, payload.wrapper_version);

    const includeAuth = normalizeBoolean(payload.include_auth) !== false;
    if (includeAuth) {
      const authResult = await handleRetrieve(
        app,
        ctx,
        enforced,
        payload,
        engine,
        runnerValidation,
        projectedVersions,
        authStore,
      );
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
    const engine = resolveAuthRequestEngine(req, payload);
    assertHostEngineEnabled(host, engine);
    const enforced = await maybeEnforceInsecure(insecure, host, 'retrieve');
    const projectedVersions = requestVersions(req);

    const userInput = extractHostUserInput(payload);
    const users = await syncService.recordHostUser(enforced.id, userInput.username, userInput.hostname);
    const out = await syncService.collect({ host: enforced, engine, bootstrap: true, users });
    out.versions = await projectedVersions(engine, payload.wrapper_version);

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
        projectedVersions,
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
      out.claude_artifacts = await claudeArtifactsService.bundle(
        enforced,
        engine,
        readArtifactDigests(payload),
      );
      out.claude_settings = await agentsService.retrieveClaudeSettings(enforced, {
        home: typeof payload.home === 'string' ? payload.home : null,
        username: typeof payload.username === 'string' ? payload.username : null,
      });
      // On-disk skills: Claude Code can't read skills over MCP (unlike codex), so
      // the fleet's shared skills are delivered as native ~/.claude/skills/<slug>/
      // SKILL.md directories. Complete live set; content/files are omitted when
      // the wrapper reports the matching complete-bundle digest.
      out.claude_skills = await skillsService.bundle(enforced, engine, readSkillDigests(payload));
    }

    // Fleet-wide managed-sync activity for the cdx/clx boot-screen activity
    // block. The response key remains `sessions` for compatibility; wrappers
    // label the counters as recent hosts / UTC syncs rather than launches.
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

type RequestVersionProjector = (
  engine: Engine,
  submittedWrapperVersion: unknown,
) => Promise<VersionSnapshot>;

async function handleRetrieve(
  app: FastifyInstance,
  ctx: RouteContext,
  host: Host,
  payload: Record<string, unknown>,
  engine: Engine,
  runnerValidation: ReturnType<typeof createRunnerValidationService>,
  projectVersions: RequestVersionProjector,
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
  const canonicalAuth = canonicalRow ? runnerValidation.canonicalAuthFromPayload(canonicalRow) : null;

  // Bump api_calls. Atomic SQL increment — avoids lost updates from concurrent
  // requests reading the same stale `host.apiCalls` snapshot.
  await ctx.db
    .update(hostsTable)
    .set({ apiCalls: sql`${hostsTable.apiCalls} + 1`, updatedAt: nowIso() })
    .where(eq(hostsTable.id, host.id));

  const versions = await projectVersions(engine, payload.wrapper_version);
  const quota = await readQuotaControls(ctx, host.vip === 1);
  const baseResponse: Record<string, unknown> = {
    canonical_last_refresh: canonicalLast,
    canonical_digest: canonicalDigest,
    canonical_generation: canonicalRow?.generation ?? undefined,
    host: buildHostPayload(host),
    api_calls: Number(host.apiCalls ?? 0) + 1,
    versions,
    ...quota,
    cdx_silent: versions.cdx_silent,
    engine,
  };
  if (engine === ENGINE_CODEX) {
    baseResponse.chatgpt = await readChatgptSnapshot(ctx, host.lanePreference);
  }

  if (!canonicalRow || !canonicalDigest) {
    return {
      ...baseResponse,
      status: 'missing',
      action: 'store',
    };
  }
  if (!canonicalAuth) {
    baseResponse.verification_state = canonicalRow.verificationState === 'failed' ? 'failed' : 'unknown';
    if (canonicalRow.verificationReason) {
      baseResponse.verification_reason = canonicalRow.verificationReason;
    }
    return { ...baseResponse, status: 'outdated' };
  }

  // Launch-gate state: host startup must not wait on the runner. The background
  // auth-verification worker keeps canonical payloads fresh; retrieve serves the
  // latest stored verdict and only refuses on a known provider-side failure.
  let servedAuth = canonicalAuth!;
  let servedDigest = canonicalDigest;
  let servedLast = canonicalLast!;
  {
    const ttlSeconds = Number(ctx.env.AUTH_RUNNER_VERIFY_TTL_SECONDS ?? 900);
    const verdict = authStore.servedVerificationSnapshot({
      engine,
      hostId: host.id,
      row: {
        id: canonicalRow.id,
        verificationState: canonicalRow.verificationState,
        verificationCheckedAt: canonicalRow.verificationCheckedAt,
        verificationReason: canonicalRow.verificationReason,
      },
      auth: canonicalAuth!,
      digest: canonicalDigest,
      lastRefresh: canonicalLast!,
      ttlSeconds,
    });
    baseResponse.verification_state = verdict.state;
    if (verdict.reason) baseResponse.verification_reason = verdict.reason;
    if (verdict.state !== 'verified') {
      // Pending, unknown, and failed rows are quarantine. Surface their
      // verdict for diagnostics, but never distribute their credential bytes.
      return { ...baseResponse, status: 'outdated' };
    }
    servedAuth = verdict.auth;
    servedDigest = verdict.digest;
    servedLast = verdict.lastRefresh;
    // Keep the advertised canonical metadata consistent with a refreshed blob.
    baseResponse.canonical_digest = servedDigest;
    baseResponse.canonical_last_refresh = servedLast;
  }

  const matchesCanonical = providedDigest && servedDigest && providedDigest === servedDigest;

  if (matchesCanonical) {
    await touchHostAuthState(ctx.db, host.id, canonicalRow.id, servedDigest, engine);
    await touchHostAuthFields(ctx.db, host.id, servedLast, servedDigest, engine);
    return { ...baseResponse, status: 'valid' };
  }
  if (compareOptionalAuthStamps(incomingLast, servedLast) >= 0) {
    // No canonical blob was served: this host explicitly reported a distinct
    // same/newer local generation that still needs to pass the store gate.
    // Preserve that presented state for admin drift reporting instead of
    // falsely marking the host synchronized before the upload succeeds.
    if (providedDigest && incomingLast) {
      await touchHostAuthFields(ctx.db, host.id, incomingLast, providedDigest, engine);
    }
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
  projectVersions: RequestVersionProjector,
): Promise<Record<string, unknown>> {
  // Atomic SQL increment — avoids lost updates from concurrent requests
  // reading the same stale `host.apiCalls` snapshot.
  await ctx.db
    .update(hostsTable)
    .set({ apiCalls: sql`${hostsTable.apiCalls} + 1`, updatedAt: nowIso() })
    .where(eq(hostsTable.id, host.id));

  const versions = await projectVersions(engine, payload.wrapper_version);
  const quota = await readQuotaControls(ctx, host.vip === 1);
  const baseResponse: Record<string, unknown> = {
    host: buildHostPayload(host),
    api_calls: Number(host.apiCalls ?? 0) + 1,
    versions,
    ...quota,
    cdx_silent: versions.cdx_silent,
    engine,
  };
  if (engine === ENGINE_CODEX) {
    baseResponse.chatgpt = await readChatgptSnapshot(ctx, host.lanePreference);
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
  projectVersions: RequestVersionProjector,
): Promise<Record<string, unknown>> {
  const candidate = readAuthCandidate(payload);
  if (!candidate)
    return handleRetrieve(app, ctx, host, payload, engine, runnerValidation, projectVersions, authStore);

  const canonicalRow = await runnerValidation.resolveCanonicalPayload(engine);
  const validated = runnerValidation.validateCanonicalPayload(canonicalRow);
  const canonicalDigest = validated?.digest ?? null;
  const canonicalLast = validated?.last_refresh ?? null;
  const canonicalAuth = canonicalRow ? runnerValidation.canonicalAuthFromPayload(canonicalRow) : null;
  const candidateLast = typeof candidate.last_refresh === 'string' ? candidate.last_refresh.trim() : '';
  const candidateMatchesFailedCanonical =
    canonicalRow?.verificationState === 'failed' && validated
      ? credentialPairMatches(runnerValidation.ensureAuthsFallback(candidate, engine), validated.auth, engine)
      : null;
  const annotateFailedCanonicalMatch = (response: Record<string, unknown>): Record<string, unknown> =>
    candidateMatchesFailedCanonical === null
      ? response
      : {
          ...response,
          candidate_matches_failed_canonical: candidateMatchesFailedCanonical,
        };
  const serveDefinitiveCandidateFallback = async (): Promise<Record<string, unknown>> => {
    const fallback = annotateFailedCanonicalMatch(
      await handleRetrieve(app, ctx, host, payload, engine, runnerValidation, projectVersions, authStore),
    );
    // This signal authorizes the wrapper to replace a locally newer candidate
    // with the older canonical. Emit it only when the candidate failure was
    // deterministic AND this response actually carries a verified canonical
    // blob. A failed/pending canonical or upload_required response must never
    // grant that authority.
    return servesVerifiedCanonicalAuth(fallback)
      ? {
          ...fallback,
          candidate_credential_rejected: true,
          candidate_rejected_definitive: true,
        }
      : { ...fallback, candidate_credential_rejected: true };
  };
  if (candidateLast) {
    try {
      assertReasonableLastRefresh(candidateLast, 'auth_candidate.last_refresh');
    } catch (err) {
      if (err instanceof ValidationError) return serveDefinitiveCandidateFallback();
      throw err;
    }
  }

  if (canonicalRow && canonicalDigest && canonicalLast && validated && canonicalAuth) {
    const candidateDigest = canonicalizedCandidateDigest(
      candidate,
      candidateLast || canonicalLast,
      engine,
      runnerValidation,
    );
    if (candidateDigest === canonicalDigest && canonicalRow.verificationState === 'verified') {
      // Candidate already matches canonical: this is the common warm-launch
      // path. Startup must not wait on live runner probes; use the latest stored
      // verdict from the background auth-verification worker.
      const baseResponse = await buildRetrieveBaseResponse(ctx, host, payload, engine, projectVersions);
      baseResponse.canonical_generation = canonicalRow.generation ?? undefined;
      let servedDigest = canonicalDigest;
      let servedLast = canonicalLast;
      {
        const ttlSeconds = Number(ctx.env.AUTH_RUNNER_VERIFY_TTL_SECONDS ?? 900);
        const verdict = authStore.servedVerificationSnapshot({
          engine,
          hostId: host.id,
          row: {
            id: canonicalRow.id,
            verificationState: canonicalRow.verificationState,
            verificationCheckedAt: canonicalRow.verificationCheckedAt,
            verificationReason: canonicalRow.verificationReason,
          },
          auth: canonicalAuth,
          digest: canonicalDigest,
          lastRefresh: canonicalLast,
          ttlSeconds,
        });
        baseResponse.verification_state = verdict.state;
        if (verdict.reason) baseResponse.verification_reason = verdict.reason;
        if (verdict.state !== 'verified') {
          return {
            ...baseResponse,
            canonical_last_refresh: servedLast,
            canonical_digest: servedDigest,
            status: 'outdated',
          };
        }
        servedDigest = verdict.digest;
        servedLast = verdict.lastRefresh;
      }
      await touchHostAuthState(ctx.db, host.id, canonicalRow.id, servedDigest, engine);
      await touchHostAuthFields(ctx.db, host.id, servedLast, servedDigest, engine);
      return {
        ...baseResponse,
        canonical_last_refresh: servedLast,
        canonical_digest: servedDigest,
        status: 'valid',
      };
    }
    if (
      candidateLast &&
      compareOptionalAuthStamps(candidateLast, canonicalLast) < 0 &&
      canonicalRow.verificationState !== 'failed' &&
      canonicalRow.verificationState !== 'pending'
    ) {
      return handleRetrieve(
        app,
        ctx,
        host,
        retrievePayloadWithCandidateFreshness(payload, candidateLast),
        engine,
        runnerValidation,
        projectVersions,
        authStore,
      );
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
      sourceKind: 'host',
      baseCanonicalGeneration:
        typeof payload.base_canonical_generation === 'number' ? payload.base_canonical_generation : null,
    });
    const baseResponse = await buildRetrieveBaseResponse(ctx, host, payload, engine, projectVersions);
    return { ...baseResponse, ...stored };
  } catch (err) {
    app.log.warn(
      { err, host: host.fqdn, engine },
      'bootstrap auth_candidate store failed; falling back to retrieve',
    );
    // A successful runner probe may already have consumed/rotated the
    // candidate's refresh token. If its replacement bytes are unusable, the
    // pre-refresh candidate is no longer safe to launch and an ordinary
    // retrieve fallback would hide that fact from concurrent wrappers.
    if (err instanceof ApiError && err.code === 'runner_updated_auth_invalid') throw err;
    // Deterministic candidate rejection (422): malformed/unusable credentials
    // or a definitive live-provider rejection. Do NOT carry their freshness
    // into the fallback. That lets retrieve serve a verified canonical and
    // heal the host; the explicit response flag tells the wrapper this is the
    // one safe exception to its local-newer anti-clobber rule.
    if (err instanceof ValidationError) {
      return serveDefinitiveCandidateFallback();
    }
    // CRITICAL (infrastructure failures only, e.g. runner outage): carry the
    // candidate's freshness into the fallback. The bundle payload has no
    // top-level last_refresh, so without this the retrieve compares
    // incoming=0 against the canonical stamp, reports the host "outdated",
    // and serves the OLDER canonical blob — which the wrapper then writes
    // over the fresher local login the store just failed to accept. With the
    // stamp threaded through, retrieve answers `upload_required` (no blob)
    // and the host keeps its newer credentials.
    return annotateFailedCanonicalMatch(
      await handleRetrieve(
        app,
        ctx,
        host,
        retrievePayloadWithCandidateFreshness(payload, candidateLast),
        engine,
        runnerValidation,
        projectVersions,
        authStore,
      ),
    );
  }
}

function credentialPairMatches(
  candidate: Record<string, unknown>,
  canonical: Record<string, unknown>,
  engine: Engine,
): boolean | null {
  const candidateIdentity = inspectCredential(candidate, engine);
  const canonicalIdentity = inspectCredential(canonical, engine);
  if (!candidateIdentity || !canonicalIdentity) return null;
  return (
    candidateIdentity.kind === canonicalIdentity.kind &&
    candidateIdentity.access === canonicalIdentity.access &&
    candidateIdentity.refresh === canonicalIdentity.refresh
  );
}

function servesVerifiedCanonicalAuth(response: Record<string, unknown>): boolean {
  return (
    response.status === 'outdated' &&
    response.verification_state === 'verified' &&
    response.auth !== null &&
    typeof response.auth === 'object' &&
    !Array.isArray(response.auth)
  );
}

/**
 * Returns a retrieve payload whose `last_refresh` reflects the freshness of
 * the auth_candidate the host presented. Candidates from vanilla `codex login`
 * carry no last_refresh; "now" is the honest stand-in — the host just minted
 * or presented the file in this very request.
 */
function retrievePayloadWithCandidateFreshness(
  payload: Record<string, unknown>,
  candidateLast: string,
): Record<string, unknown> {
  const stamp = candidateLast || nowIso();
  return { ...payload, last_refresh: stamp };
}

function readAuthCandidate(payload: Record<string, unknown>): Record<string, unknown> | null {
  const candidate = payload.auth_candidate;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  return candidate as Record<string, unknown>;
}

function compareOptionalAuthStamps(a: string | null, b: string | null): number {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  return compareRfc3339(a, b) ?? -1;
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
  const canonical = runnerValidation.canonicalizeAuthPayload(withFallback, entries, lastRefresh, engine);
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
  projectVersions: RequestVersionProjector,
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
      sourceKind: 'host',
      baseCanonicalGeneration:
        typeof payload.base_canonical_generation === 'number' ? payload.base_canonical_generation : null,
    });
  } catch (err) {
    app.log.warn({ err, host: host.fqdn, engine }, 'auth store failed');
    throw err;
  }
  const now = nowIso();
  // Atomic SQL increment — avoids lost updates from concurrent requests
  // reading the same stale `host.apiCalls` snapshot.
  await ctx.db
    .update(hostsTable)
    .set({ apiCalls: sql`${hostsTable.apiCalls} + 1`, updatedAt: now })
    .where(eq(hostsTable.id, host.id));

  const summary = await projectVersions(engine, payload.wrapper_version);
  const quota = await readQuotaControls(ctx, host.vip === 1);

  const response: Record<string, unknown> = {
    ...stored,
    api_calls: Number(host.apiCalls ?? 0) + 1,
    versions: summary,
    ...quota,
    cdx_silent: summary.cdx_silent,
    host: buildHostPayload(host),
  };
  if (engine === ENGINE_CODEX) {
    response.chatgpt = await readChatgptSnapshot(ctx, host.lanePreference);
  }
  return response;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function resolvePublicBaseUrl(req: FastifyRequest, envBase: string | undefined): string {
  if (envBase) return envBase.replace(/\/+$/, '');
  const proto = headerString(req.headers['x-forwarded-proto']) ?? req.protocol ?? 'http';
  const host =
    headerString(req.headers['x-forwarded-host']) ?? headerString(req.headers.host) ?? 'localhost';
  return `${proto}://${host}`;
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

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

function extractHostUserInput(payload: Record<string, unknown>): {
  username: string | null;
  hostname: string | null;
} {
  const sync = (payload.host_user ?? payload.sync_host_user ?? {}) as Record<string, unknown>;
  const username =
    typeof sync.username === 'string'
      ? sync.username
      : typeof payload.username === 'string'
        ? (payload.username as string)
        : null;
  const hostname =
    typeof sync.hostname === 'string'
      ? sync.hostname
      : typeof payload.hostname === 'string'
        ? (payload.hostname as string)
        : null;
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
  for (const v of list) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

async function assertApiNotDisabled(
  versions: ReturnType<typeof createVersionSnapshotService>,
): Promise<void> {
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
    auto_update_override:
      host.autoUpdateOverride === null || host.autoUpdateOverride === undefined
        ? null
        : host.autoUpdateOverride === 1,
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

async function readQuotaControls(
  ctx: RouteContext,
  vip: boolean,
): Promise<{
  quota_hard_fail: boolean;
  quota_limit_percent: number;
  quota_week_partition: 0 | 5 | 7;
}> {
  const settings = new SettingsService(ctx.db);
  const rawPartition = ((await settings.getString('quota_week_partition', 'off')) ?? 'off').trim();
  return {
    quota_hard_fail: vip ? false : await settings.getFlag('quota_hard_fail', true),
    quota_limit_percent: Math.max(50, Math.min(100, await settings.getInt('quota_limit_percent', 95))),
    quota_week_partition: rawPartition === '5' ? 5 : rawPartition === '7' ? 7 : 0,
  };
}

async function readChatgptSnapshot(
  ctx: RouteContext,
  lanePreference: string | null | undefined,
): Promise<Record<string, unknown>> {
  const unavailable = {
    status: 'unavailable',
    active_quota_lane: lanePreference === 'spark' ? 'spark' : 'normal',
  };
  try {
    const svc = new ChatGptUsageService(ctx.db, undefined, { env: ctx.env, keyring: ctx.keyring });
    const row = await svc.latest();
    if (!row) return unavailable;
    return {
      ...normalizeChatGptUsageSnapshot(row),
      // Usage snapshots are account-wide, but the active lane is host state.
      // Shape it at the host response boundary instead of leaking the
      // normal-lane default baked into the account snapshot normalizer.
      active_quota_lane: lanePreference === 'spark' ? 'spark' : 'normal',
    };
  } catch {
    return unavailable;
  }
}

import { rescueAccess, rescueHostId, isRescueMediaHost, verifyRescueToken } from '../../services/rescue-identity.js';
import { extractApiKey, hashApiKey } from '../../util/api-key-helpers.js';
import { decryptOrNull } from '../../security/secret-box.js';
import { bindOwnerHostPrincipal, resolveOwnerHost } from '../../control-plane/state/admission.js';
import { addOwnerResponseProof } from '../../control-plane/state/runtime.js';
import { ownedEngineState } from '../../control-plane/state/messaging.js';
import { UnauthorizedError, ForbiddenError } from '../../http/errors.js';
import { insecureWindowActive } from '../../services/insecure-window.js';
import { quotaSnapshot } from '../../services/quota-observation.js';
import { persistAuditLog } from '../../services/audit-log.js';
import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { recordAuthCall, flushAuthCalls, uninstallOwnedHost } from './owner.js';
import { readQuotaPolicy } from '../../services/quota-policy.js';
import { ProviderAccountsService } from '../../services/provider-accounts.js';
import { AccountSwitchService, LIVE_SWITCH_ENGINES, accountSwitchNoticeContent } from '../../services/account-switch.js';
import { quotaContinuationPending } from '../../services/watchdog-lifecycle.js';
import { reconcileQuotaExhaustion } from '../../services/quota-exhaustion.js';
import { AgentMessagingService } from '../../services/agent-messaging.js';
import { quotaNoticeId } from '../../ops/quota-worker.js';
import { hostWithCallerWrapper } from '../../services/host-wrapper-capabilities.js';
import { createPooledAuthStoreService as createCanonicalAuthStoreService } from '../../services/pooled-auth-store.js';
import { advicePool, readQuotaAdvice, quotaAdviceSnapshot, type AdvicePool } from '../../services/quota-advice.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { join, resolve } from 'node:path';
import { and, eq, inArray, isNull, desc, sql } from 'drizzle-orm';
import {
  providerAccounts,
  authPayloads,
  hostAuthDigests,
  hostAuthStates,
  hosts as hostsTable,
  installTokens,
  type Host,
} from '../../db/schema.js';
import type { RouteContext } from '../index.js';
import { ApiError, ValidationError, ServiceUnavailableError } from '../../http/errors.js';
import { compareRfc3339, nowIso } from '../../util/timestamp.js';
import { isEngine, type Engine, ENGINE_CLAUDE, ENGINE_CODEX, ENGINE_GROK, ENGINE_KIMI } from '../../util/engine.js';
import { createGrokAuthOwner } from '../../services/grok-auth-owner.js';
import { createKimiAuthOwner } from '../../services/kimi-auth-owner.js';
import { grokProjectionMetadata } from '../../services/grok-auth.js';
import { kimiProjectionMetadata } from '../../services/kimi-auth.js';
import { wsPublisher } from '../../ws/publisher.js';

import { ClientVersionsService } from '../../services/client-versions.js';
import { createHostAuthService } from '../../services/host-auth.js';
import { createInsecureWindowService } from '../../services/insecure-window.js';
import { SettingsService } from '../../services/settings.js';
import {
  applyHostVersionPolicy,
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
  touchHostAuthFields,
  touchHostAuthState,
} from '../../services/canonical-auth-store.js';
import { createWrapperBinRegistry } from '../../services/wrapper-bin-registry.js';
import { projectWrapperVersionSnapshot } from '../../services/wrapper-version-projection.js';
import { ChatGptUsageService, normalizeChatGptUsageSnapshot } from '../../services/chatgpt-usage.js';
import { CLAUDE_SHORT_WINDOW_MS, CLAUDE_WEEKLY_WINDOW_MS, ClaudeUsageService, normalizeClaudeUsageSnapshot, reportedClaudeWindow } from '../../services/claude-usage.js';
import { grokUsageAuthFields, readGrokUsage } from '../../services/grok-usage.js';
import { kimiUsageAuthFields, readKimiUsage } from '../../services/kimi-usage.js';
import {
  activeHostEngines,
  assertHostEngineAssigned,
  assertHostEngineEnabled,
  disabledEngines,
  hostEnginesList,
  type FleetEngineState,
} from '../../services/host-engine-policy.js';
import { readFleetEngineState } from '../../services/engine-switch.js';
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
  app.addHook('onClose', async () => {
    const owner = ownerRuntimeFor(ctx.db);
    if (owner) await flushAuthCalls(owner);
  });
  const insecure = createInsecureWindowService({ db: ctx.db, env: ctx.env });
  const hostAuth = createHostAuthService({ db: ctx.db, env: ctx.env, insecure });
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
  const requestVersions = (req: FastifyRequest, host: Host, reuse = false): RequestVersionProjector => {
    const platform = resolveWrapperPlatform(req.headers);
    const publicBaseUrl = resolvePublicBaseUrl(req, ctx.env.PUBLIC_BASE_URL);
    const summaries = new Map<Engine, Promise<VersionSnapshot>>();
    const projections = new Map<Engine, Promise<VersionSnapshot>>();
    const invalidate = () => {
      summaries.clear();
      projections.clear();
    };
    const summary = (engine: Engine): Promise<VersionSnapshot> => {
      if (!reuse) return versions.summary(engine);
      let pending = summaries.get(engine);
      if (!pending) {
        pending = versions.summary(engine).catch((error) => {
          invalidate();
          throw error;
        });
        summaries.set(engine, pending);
      }
      return pending;
    };
    const project: RequestVersionProjector = Object.assign(
      (engine: Engine): Promise<VersionSnapshot> => {
        const cached = projections.get(engine);
        if (cached) return cached;
        const pending = (async () =>
          applyHostVersionPolicy(
            await projectWrapperVersionSnapshot({
              snapshot: await summary(engine),
              engine,
              platform,
              publicBaseUrl,
              binaries,
            }),
            host,
            engine,
          ))().catch((error) => {
          invalidate();
          throw error;
        });
        if (reuse) projections.set(engine, pending);
        return pending;
      },
      { summary, invalidate },
    );
    return project;
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

  const accounts = new ProviderAccountsService(ctx.db, ctx.keyring);
  const switches = new AccountSwitchService(ctx.db, ctx.keyring);
  // Binding generation, pending switch and (for pools) the quota recommendation.
  const sessionExtras = async (hostId: number, engine: Engine, sessionId: unknown) =>
    typeof sessionId === 'string' && LIVE_SWITCH_ENGINES.has(engine)
      ? await switches.sessionBinding(hostId, engine, sessionId).catch(() => ({}))
      : {};
  // A media identity is deliberately recognized only on this route. Neither
  // generic host authentication nor communicator/MCP accepts the derived key.
  app.post('/rescue/v1/session', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    await assertApiNotDisabled(versions);
    const payload = readPayload(req.body);
    const { engine, action } = payload;
    if (engine !== 'codex' && engine !== 'claude') throw new ValidationError('Unknown rescue engine');
    if (action !== 'start' && action !== 'release' && action !== 'heartbeat' && action !== 'version')
      throw new ValidationError('Unknown rescue action');
    const token = extractApiKey(req.headers) ?? '';
    const id = rescueHostId(token);
    const [row] = await ctx.db.select().from(hostsTable).where(eq(hostsTable.id, id)).limit(1);
    const key = row && isRescueMediaHost(row) ? decryptOrNull(row.apiKeyEnc, ctx.keyring) : null;
    if (!row || !key || !verifyRescueToken(id, key, token)) throw new UnauthorizedError('Invalid rescue identity');
    // Check approval before auth can bind a roaming IP. Release and version
    // never need provider material or an IP change.
    // SQL stores the encrypted key. The owner holds the current host policy,
    // including window deadlines that may differ from persisted timestamps.
    const owner = ownerRuntimeFor(ctx.db);
    let host = owner ? resolveOwnerHost(ctx.db, hashApiKey(key), key) : { ...row, apiKey: key, apiKeyEnc: null };
    if (!host || host.id !== id || !isRescueMediaHost(host) || host.status !== 'active' ||
        (host.expiresAt && Date.parse(host.expiresAt) <= Date.now()))
      throw new UnauthorizedError('Inactive rescue identity');
    const launch = action === 'start' || action === 'heartbeat';
    if (launch && !insecureWindowActive(host)) throw new ForbiddenError('Open the rescue host window in the fleet portal', 'rescue_approval_required');
    if (launch) {
      host = await hostAuth.authenticate({
        headers: { authorization: 'Bearer ' + key }, method: 'POST', clientIp: req.clientIp, query: {},
      } as FastifyRequest);
      if (!isRescueMediaHost(host) || !insecureWindowActive(host))
        throw new ForbiddenError('Rescue access closed', 'rescue_approval_required');
    }
    if (owner) {
      bindOwnerHostPrincipal(ctx.db, host, launch);
      addOwnerResponseProof('rescue-policy', snapshot => {
        const current = snapshot.hosts.get(id);
        if (!current || !isRescueMediaHost(current)) throw new UnauthorizedError('Rescue identity changed');
        if (action !== 'release') assertHostEngineEnabled(current, engine, ownedEngineState(snapshot));
      });
    }
    if (action !== 'release') assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
    if (action === 'version') {
      const policy = applyHostVersionPolicy(await versions.summary(engine), host, engine);
      return { host: host.fqdn, version: policy.client_version_override ?? policy.client_version, auto_update: policy.auto_update_enabled };
    }
    const session = opaqueId(payload.session_id, 'session_id');
    if (action === 'release') {
      await accounts.release(id, engine, session);
      return { released: true };
    }
    if (action === 'heartbeat') {
      await accounts.heartbeat(id, engine, session);
      return { active: true };
    }
    const quota = await readQuotaControls(ctx, false, engine);
    const lease = await accounts.acquire(id, engine, 'rescue-media', session, quota.quota_limit_percent, undefined, 'timed');
    try {
      const canonical = await runnerValidation.resolveCanonicalPayload(engine, lease.account.id);
      const auth = canonical ? runnerValidation.canonicalAuthFromPayload(canonical) : null;
      return rescueAccess(engine, auth);
    } catch (error) {
      await accounts.release(id, engine, session);
      throw error;
    }
  });
  // Launch reservations are idempotent and scoped to a local auth directory.
  app.post('/auth/sessions', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = resolveAuthRequestEngine(req, payload);
    assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
    await maybeEnforceInsecure(insecure, host, 'retrieve', req.clientIp, unattendedRequest(req));
    const scope = opaqueId(payload.scope_id, 'scope_id');
    const sessionId = opaqueId(payload.session_id, 'session_id');
    let quota = await readQuotaControls(ctx, host.vip === 1, engine);
    const preferred = accountIdFrom(payload.account_id);
    if (
      payload.ownership_mode !== undefined &&
      payload.ownership_mode !== 'timed' &&
      payload.ownership_mode !== 'connection'
    )
      throw new ValidationError('ownership_mode must be timed or connection', { param: 'ownership_mode' });
    // Old wrappers cannot establish a provider attachment before their first
    // auth confirmation. Connection ownership requires explicit negotiation.
    const ownershipMode = payload.ownership_mode === 'connection' ? 'connection' : 'timed';
    const lease = await accounts.acquire(
      host.id,
      engine,
      scope,
      sessionId,
      quota.quota_limit_percent,
      preferred,
      ownershipMode,
    );
    quota = await readQuotaControls(ctx, host.vip === 1, engine, lease.account.id);
    if (engine === ENGINE_GROK) {
      try {
        const snapshot = await createGrokAuthOwner({ db: ctx.db, keyring: ctx.keyring, runner }).ensureFresh({
          accountId: lease.account.id,
          sourceHostId: host.id,
          sessionId,
          bootstrapSession: true,
        });
        return {
          account_id: lease.account.id,
          account_label: lease.account.label,
          session_id: sessionId,
          ownership_mode: 'ownership_mode' in lease ? lease.ownership_mode : 'timed',
          expires_at: lease.expires_at,
          access_expires_at: snapshot.expires_at,
          auth: snapshot.auth,
          canonical_digest: snapshot.digest,
          canonical_last_refresh: snapshot.last_refresh,
          canonical_generation: snapshot.canonical_generation,
          access_token_digest: snapshot.access_token_digest,
          verification_state: 'verified',
          refresh_state: snapshot.refresh_state,
          usage: { supported: false },
          ...quota,
        };
      } catch (error) {
        await accounts.release(host.id, engine, sessionId);
        throw error;
      }
    }
if (engine === ENGINE_KIMI) {
      try {
        const snapshot = await createKimiAuthOwner({ db: ctx.db, keyring: ctx.keyring, runner }).ensureFresh({
          accountId: lease.account.id,
          sourceHostId: host.id,
          sessionId,
          bootstrapSession: true,
        });
        return {
          account_id: lease.account.id,
          account_label: lease.account.label,
          session_id: sessionId,
          ownership_mode: 'ownership_mode' in lease ? lease.ownership_mode : 'timed',
          expires_at: lease.expires_at,
          access_expires_at: snapshot.expires_at,
          auth: snapshot.auth,
          canonical_digest: snapshot.digest,
          canonical_last_refresh: snapshot.last_refresh,
          canonical_generation: snapshot.canonical_generation,
          access_token_digest: snapshot.access_token_digest,
          verification_state: 'verified',
          refresh_state: snapshot.refresh_state,
          usage: await readKimiUsage(ctx.db, lease.account.id),
          ...quota,
        };
      } catch (error) {
        await accounts.release(host.id, engine, sessionId);
        throw error;
      }
    }
    const row = await runnerValidation.resolveCanonicalPayload(engine, lease.account.id);
    const auth = row ? runnerValidation.canonicalAuthFromPayload(row) : null;
    // A launch that joins a live scope shares its credentials file and with it
    // the scope's account, also one that was paused or lost its verification
    // meanwhile. It cannot be bound elsewhere on its own; the policy moves the
    // whole scope, and this launch then carries the directive like its siblings.
    const unusable = lease.account.state !== 'enabled' || row?.verificationState !== 'verified';
    if (!row || !auth) await accounts.release(host.id, engine, sessionId);
    if (unusable && LIVE_SWITCH_ENGINES.has(engine))
      await switches.evaluate(engine).catch((err) => app.log.warn({ err }, 'account policy evaluation failed'));
    if (!row || !auth) throw new ServiceUnavailableError('Selected account is unavailable', 'account_unavailable');
    return {
      account_id: lease.account.id,
      account_label: lease.account.label,
      session_id: sessionId,
      ownership_mode: 'ownership_mode' in lease ? lease.ownership_mode : 'timed',
      expires_at: lease.expires_at,
      auth,
      canonical_digest: row.sha256,
      canonical_last_refresh: row.lastRefresh,
      verification_state: row.verificationState,
      ...quota,
      ...(await sessionExtras(host.id, engine, sessionId)),
    };
  });
  app.post('/auth/sessions/heartbeat', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = resolveAuthRequestEngine(req, payload);
    // A fleet suspension refuses new leases but lets a running session keep
    // the one it holds; it does stop the server refreshing on its behalf.
    assertHostEngineAssigned(host, engine);
    // A lease heartbeat is a running session's timer, never an operator
    // launch: it must not open an approval nobody is there to answer.
    await maybeEnforceInsecure(insecure, host, 'retrieve', req.clientIp, true);
    const sessionId = opaqueId(payload.session_id, 'session_id');
    const heartbeat = await accounts.heartbeat(host.id, engine, sessionId);
    if (engine !== ENGINE_GROK && engine !== ENGINE_KIMI)
      return { ...heartbeat, ...(await sessionExtras(host.id, engine, sessionId)) };
    if (!(await readFleetEngineState(ctx.db))[engine]) return { ...heartbeat, refresh_state: 'suspended' };
    const snapshot = await (engine === ENGINE_KIMI ? createKimiAuthOwner : createGrokAuthOwner)({ db: ctx.db, keyring: ctx.keyring, runner }).ensureFresh({
      accountId: heartbeat.account_id,
      sourceHostId: host.id,
      sessionId,
    });
    return {
      ...heartbeat,
      canonical_generation: snapshot.canonical_generation,
      access_token_digest: snapshot.access_token_digest,
      access_expires_at: snapshot.expires_at,
      refresh_state: snapshot.refresh_state,
    };
  });
  app.post('/auth/sessions/release', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = resolveAuthRequestEngine(req, payload);
    await accounts.release(host.id, engine, opaqueId(payload.session_id, 'session_id'));
    return { status: 'ok' };
  });

  // POST /auth — primary wrapper probe.
  app.post('/auth', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = resolveAuthRequestEngine(req, payload);
    assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
    await enforceAccountSession(accounts, host.id, engine, payload);
    const command = normalizeCommand(payload.command);
    const enforcedHost = await maybeEnforceInsecure(insecure, host, command, req.clientIp, unattendedRequest(req));
    const projectedVersions = requestVersions(req, enforcedHost);

    const result =
      command === 'retrieve'
        ? await handleRetrieve(app, ctx, enforcedHost, payload, engine, runnerValidation, projectedVersions, authStore)
        : await handleStore(app, ctx, enforcedHost, payload, engine, authStore, runnerValidation, projectedVersions);
    return withPoolExtras(result, enforcedHost.id, engine, payload.session_id);
  });

  const withPoolExtras = async (
    result: Record<string, unknown>,
    hostId: number,
    engine: Engine,
    sessionId: unknown,
  ): Promise<Record<string, unknown>> => {
    if (!result || typeof result !== 'object') return result;
    const extras: Record<string, unknown> = await sessionExtras(hostId, engine, sessionId);
    const accountId = typeof result.account_id === 'number' ? result.account_id : null;
    if (accountId !== null) {
      try {
        const boundAt = typeof sessionId === 'string' ? await switches.boundAt(hostId, engine, sessionId) : null;
        const view = await switches.poolView(engine, accountId, undefined, boundAt);
        if (view.accounts.length > 1)
          extras.quota_pool = {
            recommendation: view.recommendation,
            policy: { mode: view.policy.mode, strategy: view.policy.strategy },
            bound_account_id: view.bound_account_id,
            headroom: view.headroom,
            launch_account_id: view.launch_account_id,
            live_switch: LIVE_SWITCH_ENGINES.has(engine),
            accounts: view.accounts.map((a) => ({
              id: a.id,
              label: a.label,
              state: a.state,
              verified: a.verified,
              short_used_percent: a.short_used_percent,
              short_resets_at: a.short_resets_at,
              weekly_used_percent: a.weekly_used_percent,
              weekly_resets_at: a.weekly_resets_at,
              fetched_at: a.fetched_at,
              score: a.score,
              emulation_blocked: a.emulation_blocked,
            })),
          };
      } catch {
        // Pool details are advisory; the auth answer stands without them.
      }
    }
    return { ...result, ...extras };
  };

  // GET /auth/accounts — the engine's pool for `clx accounts` and agent tools.
  app.get('/auth/accounts', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const engine = resolveAuthRequestEngine(req, query);
    assertHostEngineAssigned(host, engine);
    // Labels are usually e-mail addresses: same window as credential retrieval.
    await maybeEnforceInsecure(insecure, host, 'retrieve', req.clientIp, unattendedRequest(req));
    let boundAccountId: number | null = null;
    let boundAt: string | null = null;
    let binding: Record<string, unknown> = { binding_generation: null, account_switch: null };
    if (query.session_id !== undefined) {
      const session = await accounts.session(host.id, engine, opaqueId(query.session_id, 'session_id'));
      boundAccountId = session.accountId;
      boundAt = session.boundAt ?? session.createdAt;
      binding = await switches.sessionBinding(host.id, engine, session.id);
    }
    const view = await switches.poolView(engine, boundAccountId, undefined, boundAt);
    return {
      engine,
      policy: view.policy,
      bound_account_id: boundAccountId,
      ...binding,
      live_switch: LIVE_SWITCH_ENGINES.has(engine),
      accounts: view.accounts.map(({ last_selected_at: _ignored, ...a }) => a),
      recommendation: view.recommendation,
    };
  });

  // POST /auth/sessions/switch-request — `clx accounts use` and the agent tool.
  app.post('/auth/sessions/switch-request', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = resolveAuthRequestEngine(req, payload);
    assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
    await maybeEnforceInsecure(insecure, host, 'retrieve', req.clientIp, unattendedRequest(req));
    const session = await accounts.session(host.id, engine, opaqueId(payload.session_id, 'session_id'));
    const target = payload.account_id === 'auto' ? 'auto' : accountIdFrom(payload.account_id);
    if (target === undefined) throw new ValidationError('account_id must be an account ID or "auto"', { param: 'account_id' });
    const reason = payload.reason === 'agent' ? 'agent' : 'host';
    return switches.requestSwitch({ hostId: host.id, engine, scopeId: session.scopeId, target, reason, actor: host.fqdn });
  });

  // POST /auth/sessions/switch — commit by the wrapper that performs the switch.
  app.post('/auth/sessions/switch', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = resolveAuthRequestEngine(req, payload);
    assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
    await maybeEnforceInsecure(insecure, host, 'retrieve', req.clientIp, true);
    const sessionId = opaqueId(payload.session_id, 'session_id');
    const target = accountIdFrom(payload.account_id);
    const generation = payload.binding_generation;
    if (target === undefined) throw new ValidationError('account_id is required', { param: 'account_id' });
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1)
      throw new ValidationError('binding_generation must be a positive integer', { param: 'binding_generation' });
    const scopeId = opaqueId(payload.scope_id, 'scope_id');
    // The target's credentials are read before the binding moves: a commit
    // that then cannot serve them would leave the scope bound to an account
    // it has no login for.
    const ready = await runnerValidation.resolveCanonicalPayload(engine, await accounts.canonicalId(target, engine));
    const committed = await switches.commitSwitch({
      hostId: host.id,
      engine,
      sessionId,
      scopeId,
      accountId: target,
      generation,
      credentialsReady: !!ready && !!runnerValidation.canonicalAuthFromPayload(ready),
    });
    if (payload.credential_write === 'unfinished')
      await switches
        .reportUnfinishedWrite(host.id, engine, scopeId, committed.account_id, committed.binding_generation)
        .catch((err) => req.log.warn({ err }, 'unfinished account switch write not recorded'));
    // A session that waits to continue a quota-failed turn learns of its new
    // account from that continuation; every other moved session gets the notice.
    const continuing = await quotaContinuationPending(ctx.db, committed.moved_addresses).catch(() => new Set<string>());
    const noticed = committed.moved_addresses.filter((address) => !continuing.has(address));
    if (noticed.length) {
      // Best effort: the switch is committed; a failed notice must not undo it.
      try {
        const pool = await switches.pool(engine);
        const content = accountSwitchNoticeContent(
          engine,
          pool.find((a) => a.id === committed.previous_account_id),
          pool.find((a) => a.id === committed.account_id),
          committed.reason,
        );
        const noticeId = quotaNoticeId(`account-switch:${host.id}:${engine}:${opaqueId(payload.scope_id, 'scope_id')}:${committed.binding_generation}`);
        await new AgentMessagingService(ctx.db, ctx.env, ctx.keyring).noticeAddresses(noticed, content, noticeId);
      } catch (err) {
        req.log.warn({ err }, 'account switch notice failed');
      }
    }
    const row = await runnerValidation.resolveCanonicalPayload(engine, committed.account_id);
    const auth = row ? runnerValidation.canonicalAuthFromPayload(row) : null;
    if (!row || !auth) throw new ServiceUnavailableError('Selected account is unavailable', 'account_unavailable');
    const account = await accounts.get(committed.account_id, engine);
    return {
      account_id: committed.account_id,
      account_label: account.label,
      session_id: sessionId,
      binding_generation: committed.binding_generation,
      previous_account_id: committed.previous_account_id,
      replayed: committed.replayed,
      auth,
      canonical_digest: row.sha256,
      canonical_last_refresh: row.lastRefresh,
      verification_state: row.verificationState,
      ...(await readQuotaControls(ctx, host.vip === 1, engine, committed.account_id)),
    };
  });

  // DELETE /auth — host uninstall.
  app.delete('/auth', { config: { ownerResponse: 'committed-action' } }, async (req) => {
    const host = await hostAuth.authenticate(req);
    const query = req.query as { force?: string; engine?: string };
    const force = query.force === '1';
    const explicitEngine = typeof query.engine === 'string' && query.engine.trim() !== '';
    const owner = ownerRuntimeFor(ctx.db);
    if (owner) {
      const requested = explicitEngine ? query.engine!.trim().toLowerCase() : undefined;
      if (requested && !isEngine(requested))
        throw new ValidationError('engine must be "codex", "claude", "grok" or "kimi"', { param: 'engine' });
      return uninstallOwnedHost(owner, host, requested as Engine | undefined, force);
    }
    if (explicitEngine) {
      const engine = query.engine!.trim().toLowerCase();
      if (!isEngine(engine)) {
        throw new ValidationError('engine must be "codex", "claude", "grok" or "kimi"', { param: 'engine' });
      }
      // Uninstalling a suspended engine is cleanup, not use: host check only.
      assertHostEngineAssigned(host, engine);
      const remaining = hostEnginesList(host.engines).filter((item) => item !== engine);
      if (remaining.length > 0) {
        const now = nowIso();
        await ctx.db.transaction(async (tx) => {
          await suspendAgentMessagingRuntimeLocked(tx, host.id, 'engine_disabled', [engine]);
          await persistAuditLog(tx, {
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
              ...(engine === ENGINE_KIMI ? { kimiAuthDigest: null, kimiLastRefresh: null, kimiClientVersion: null, kimiClientVersionOverride: null, kimiWrapperVersion: null, kimiModelOverride: null, kimiReasoningEffortOverride: null } : engine === ENGINE_GROK
                ? {
                    grokAuthDigest: null,
                    grokLastRefresh: null,
                    grokClientVersion: null,
                    grokClientVersionOverride: null,
                    grokWrapperVersion: null,
                    grokModelOverride: null,
                    grokReasoningEffortOverride: null,
                  }
                : engine === ENGINE_CLAUDE
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
      await persistAuditLog(tx, {
        hostId: null,
        action: 'host.delete',
        details: JSON.stringify({ host_id: host.id, fqdn: host.fqdn, initiator: 'host_api', force }),
        createdAt: nowIso(),
      });
      await tx.delete(installTokens).where(eq(installTokens.hostId, host.id));
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
    assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
    const includeAuth = normalizeBoolean(payload.include_auth) !== false;
    const enforced = await maybeEnforceInsecure(
      insecure,
      host,
      includeAuth ? 'retrieve' : null,
      req.clientIp,
      unattendedRequest(req),
    );
    const projectedVersions = requestVersions(req, enforced);

    const userInput = extractHostUserInput(payload);
    const users = await syncService.recordHostUser(enforced.id, userInput.username, userInput.hostname);
    const out = await syncService.collect({ host: enforced, engine, bootstrap: false, users });
    out.versions = await projectedVersions(engine);

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

  // POST /claude/usage/report — clx's fleet-owned statusLine command pushes
  // what Claude Code's own `rate_limits` payload just reported. This is
  // deliberately push, never pull: the server holds no Claude OAuth token and
  // calls no Anthropic/claude.ai endpoint to obtain this number. A report
  // with no usable window is accepted (200) but stored nowhere.
  app.post('/claude/usage/report', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    assertHostEngineEnabled(host, ENGINE_CLAUDE, await readFleetEngineState(ctx.db));
    // A reading steers the account pool, so it is held to the same window as
    // the credentials it describes. Unattended: a closed window refuses the
    // report and never opens an approval request for a statusline render.
    await maybeEnforceInsecure(insecure, host, 'retrieve', req.clientIp, true);
    const payload = readPayload(req.body);
    const sessionId = payload.session_id === undefined ? undefined : opaqueId(payload.session_id, 'session_id');
    let claimed = accountIdFrom(payload.account_id);
    const now = Date.now();
    const fiveHour = reportedClaudeWindow(payload.five_hour, CLAUDE_SHORT_WINDOW_MS, now);
    const sevenDay = reportedClaudeWindow(payload.seven_day, CLAUDE_WEEKLY_WINDOW_MS, now);
    if (!fiveHour && !sevenDay) {
      const sent = payload.five_hour !== undefined || payload.seven_day !== undefined;
      return sent ? { status: 'ignored', reason: 'no_current_window' } : { status: 'ignored' };
    }
    if (claimed !== undefined) claimed = await accounts.canonicalId(claimed, ENGINE_CLAUDE);
    const target = await switches.usageReportAccount(
      host.id,
      ENGINE_CLAUDE,
      { sessionId, accountId: claimed, short_resets_at: fiveHour?.resetsAt ?? null, weekly_resets_at: sevenDay?.resetsAt ?? null },
      now,
    );
    if ('ignored' in target) return { status: 'ignored', reason: target.ignored };
    const accountId = target.accountId;
    const svc = new ClaudeUsageService(ctx.db, accountId);
    const previous = ownerRuntimeFor(ctx.db) ? await svc.latest() : null;
    const row = await svc.store({
      accountId,
      hostId: host.id,
      source: typeof payload.source === 'string' ? payload.source : null,
      fiveHourUsedPercent: fiveHour?.usedPercent ?? null,
      fiveHourResetsAt: fiveHour?.resetsAt ?? null,
      sevenDayUsedPercent: sevenDay?.usedPercent ?? null,
      sevenDayResetsAt: sevenDay?.resetsAt ?? null,
    });
    // A reading of a new window ends the account's exhaustion marker; the same
    // or a lower figure of the old one never does.
    const renewed =
      row && accountId !== undefined
        ? await reconcileQuotaExhaustion(ctx.db, ENGINE_CLAUDE, accountId, {
            short_resets_at: row.fiveHourResetsAt ?? null,
            long_resets_at: row.sevenDayResetsAt ?? null,
          }).catch((err) => {
            app.log.warn({ err }, 'quota exhaustion marker not reconciled');
            return false;
          })
        : false;
    if (renewed) void switches.evaluate(ENGINE_CLAUDE).catch((err) => app.log.warn({ err }, 'account policy evaluation failed'));
    if (row && row.id !== previous?.id) {
      wsPublisher.publish('claude.usage.updated', { fetched_at: row.fetchedAt });
      // A fresh reading may move a scope under the automatic policy.
      void switches.evaluate(ENGINE_CLAUDE).catch((err) => app.log.warn({ err }, 'account policy evaluation failed'));
    }
    return { status: row ? 'ok' : 'ignored' };
  });

  // POST /sync/bootstrap — full first-run sync.
  app.post('/sync/bootstrap', async (req) => {
    await assertApiNotDisabled(versions);
    const host = await hostAuth.authenticate(req);
    const payload = readPayload(req.body);
    const engine = resolveAuthRequestEngine(req, payload);
    assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
    await enforceAccountSession(accounts, host.id, engine, payload);
    const includeAuth = normalizeBoolean(payload.include_auth) !== false;
    // `include_content:false` is the communicator warm-cache launch: the local
    // owner already holds current content (kept fresh by pushed invalidations),
    // so the launch asks only for the auth/host/version blocks it needs before
    // exec. No content renderer runs, so no MCP token is minted and no content
    // log is written; the response omits every content key rather than sending
    // empty ones, which a wrapper could otherwise mistake for a deletion.
    const includeContent = normalizeBoolean(payload.include_content) !== false;
    const enforced = await maybeEnforceInsecure(
      insecure,
      host,
      includeAuth ? 'retrieve' : null,
      req.clientIp,
      unattendedRequest(req),
    );
    // This request's collect/envelope/auth reads share one refresh and artifact
    // projection. Auth mutations below invalidate it before reading again.
    const projectedVersions = requestVersions(req, enforced, true);

    const userInput = extractHostUserInput(payload);
    const users = await syncService.recordHostUser(enforced.id, userInput.username, userInput.hostname);
    const out = await syncService.collect({
      host: enforced,
      engine,
      bootstrap: true,
      users,
      versionSnapshot: await projectedVersions.summary(engine),
    });
    out.versions = await projectedVersions(engine);

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
      // Same pool extras as POST /auth: a launch usually reuses this answer
      // after its account lease, so the card and picker read the pool here.
      out.auth = await withPoolExtras(authResult, enforced.id, engine, payload.session_id);
      const status = ((authResult as { status?: string }).status ?? '').toLowerCase();
      if (status !== 'valid') {
        out.reasons.push(`auth_${status !== '' ? status : 'unknown'}`);
      }
      if (status === 'updated') out.reasons.push('auth_stored');
    }

    if (!includeContent) {
      out.content = 'omitted';
      out.reasons = uniqueNonEmpty(out.reasons);
      out.status = out.reasons.length === 0 ? 'ok' : 'update';
      return out;
    }

    // Inline the agents + client-config bodies so the wrapper's bundle path can
    // refresh them in the same round-trip. The wrapper sends the local file
    // digests as `agents`/`config`; the services return `status: 'unchanged'`
    // when they match (no `content` field), and `status: 'updated'` with the
    // full body otherwise — `resourceContent()` on the wrapper unwraps either.
    const agentsDigest = typeof payload.agents === 'string' ? (payload.agents as string) : null;
    const configDigest = typeof payload.config === 'string' ? (payload.config as string) : null;
    out.agents = await agentsService.retrieve(agentsDigest, enforced, engine);
    out.memory_routing = (out.agents as Record<string, unknown>).memory_routing;
    const configHost = hostWithCallerWrapper(enforced, engine, req.headers['x-wrapper-version']);
    out.config = await agentsService.retrieveConfig(configDigest, configHost, engine, {
      home: typeof payload.home === 'string' ? payload.home : null,
      username: typeof payload.username === 'string' ? payload.username : null,
    });
    const managedMcpEnabled = (out.memory_routing as { enabled?: boolean } | undefined)?.enabled === true;
    if (engine === ENGINE_CODEX && payload.codex_skill_entries === true) {
      out.codex_skills = managedMcpEnabled
        ? await skillsService.codexEntries(enforced, readSkillDigests(payload))
        : [];
    }

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
      out.claude_settings = await agentsService.retrieveClaudeSettings(configHost, {
        home: typeof payload.home === 'string' ? payload.home : null,
        username: typeof payload.username === 'string' ? payload.username : null,
      });
      // The memory-routing flag is the resolved managed-MCP availability gate,
      // returned even without an agents document. Reuse it so Skill guidance and
      // delivery cannot disagree. An explicit empty set retires only previously
      // fleet-owned native copies; omitted/disabled MCP keeps the native fallback.
      out.claude_skills = managedMcpEnabled
        ? []
        : await skillsService.bundle(enforced, engine, readSkillDigests(payload));
    }
    // Grok Build loads the same SKILL.md layout natively from ~/.grok/skills, so
    // it receives the identical complete live set instead of relying on MCP alone.
    if (engine === ENGINE_GROK) {
      out.grok_skills = await skillsService.bundle(enforced, engine, readSkillDigests(payload));
    }
if (engine === ENGINE_KIMI) {
      out.kimi_skills = await skillsService.bundle(enforced, engine, readSkillDigests(payload));
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

type RequestVersionProjector = {
  (engine: Engine): Promise<VersionSnapshot>;
  summary(engine: Engine): Promise<VersionSnapshot>;
  invalidate(): void;
};

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
  if (engine === ENGINE_GROK) {
    if (payload.metadata_only === true) {
      // Startup must reach account selection even when the old/default head
      // needs login. Doctor must never spend a rotating refresh credential.
      const row = await runnerValidation.resolveCanonicalPayload(engine, accountIdFrom(payload.account_id));
      const snapshot = row ? runnerValidation.validateCanonicalPayload(row) : null;
      const base = await buildRetrieveBaseResponse(ctx, host, payload, engine, projectVersions);
      base.grok_usage = await readGrokUsageSnapshot(ctx, row?.accountId ?? accountIdFrom(payload.account_id));
      return {
        ...base,
        account_pool: true,
        metadata_only: true,
        status: snapshot ? 'available' : 'missing',
        verification_state: row?.verificationState ?? 'unknown',
        canonical_generation: row?.generation ?? null,
        canonical_last_refresh: snapshot?.last_refresh ?? null,
        ...(snapshot ? grokProjectionMetadata(snapshot.auth) : {}),
        // status/verification_state describe one head; a launch leases from the
        // pool, so status also needs to know whether any account is leasable.
        pool_verified_accounts: await new ProviderAccountsService(ctx.db, ctx.keyring).countLeasable(engine),
        usage: { supported: false },
      };
    }
    const refresh = payload.refresh_if_generation;
    if (refresh !== undefined && (!Number.isSafeInteger(refresh) || Number(refresh) < 0))
      throw new ValidationError('refresh_if_generation must be a non-negative integer', {
        param: 'refresh_if_generation',
      });
    const snapshot = await createGrokAuthOwner({
      db: ctx.db,
      keyring: ctx.keyring,
      runner: createRunnerClient({ env: ctx.env }),
    }).ensureFresh({
      accountId: accountIdFrom(payload.account_id),
      sourceHostId: host.id,
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
      refreshIfGeneration: refresh === undefined ? undefined : Number(refresh),
    });
    projectVersions.invalidate();
    const base = await buildRetrieveBaseResponse(ctx, host, payload, engine, projectVersions);
    base.grok_usage = await readGrokUsageSnapshot(ctx, snapshot.row.accountId ?? undefined);
    await touchHostAuthState(ctx.db, host.id, snapshot.row.id, snapshot.digest, engine);
    await touchHostAuthFields(ctx.db, host.id, snapshot.last_refresh, snapshot.digest, engine);
    return {
      ...base,
      account_pool: true,
      account_id: snapshot.row.accountId,
      canonical_digest: snapshot.digest,
      canonical_last_refresh: snapshot.last_refresh,
      canonical_generation: snapshot.canonical_generation,
      ...grokProjectionMetadata(snapshot.auth),
      verification_state: 'verified',
      refresh_state: snapshot.refresh_state,
      status: extractDigest(payload, false) === snapshot.digest ? 'valid' : 'outdated',
      auth: snapshot.auth,
      usage: {
        supported: false,
        short_used_percent: null,
        short_resets_at: null,
        weekly_used_percent: null,
        weekly_resets_at: null,
      },
    };
  }
if (engine === ENGINE_KIMI) {
    if (payload.metadata_only === true) {
      // Startup must reach account selection even when the old/default head
      // needs login. Doctor must never spend a rotating refresh credential.
      const row = await runnerValidation.resolveCanonicalPayload(engine, accountIdFrom(payload.account_id));
      const snapshot = row ? runnerValidation.validateCanonicalPayload(row) : null;
      const base = await buildRetrieveBaseResponse(ctx, host, payload, engine, projectVersions);
      base.kimi_usage = await readKimiUsageSnapshot(ctx, row?.accountId ?? accountIdFrom(payload.account_id));
      return {
        ...base,
        account_pool: true,
        metadata_only: true,
        status: snapshot ? 'available' : 'missing',
        verification_state: row?.verificationState ?? 'unknown',
        canonical_generation: row?.generation ?? null,
        canonical_last_refresh: snapshot?.last_refresh ?? null,
        ...(snapshot ? kimiProjectionMetadata(snapshot.auth) : {}),
        // status/verification_state describe one head; a launch leases from the
        // pool, so status also needs to know whether any account is leasable.
        pool_verified_accounts: await new ProviderAccountsService(ctx.db, ctx.keyring).countLeasable(engine),
        usage: row?.accountId ? await readKimiUsage(ctx.db, row.accountId) : { supported: false },
      };
    }
    const refresh = payload.refresh_if_generation;
    if (refresh !== undefined && (!Number.isSafeInteger(refresh) || Number(refresh) < 0))
      throw new ValidationError('refresh_if_generation must be a non-negative integer', {
        param: 'refresh_if_generation',
      });
    const snapshot = await createKimiAuthOwner({
      db: ctx.db,
      keyring: ctx.keyring,
      runner: createRunnerClient({ env: ctx.env }),
    }).ensureFresh({
      accountId: accountIdFrom(payload.account_id),
      sourceHostId: host.id,
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
      refreshIfGeneration: refresh === undefined ? undefined : Number(refresh),
    });
    projectVersions.invalidate();
    const base = await buildRetrieveBaseResponse(ctx, host, payload, engine, projectVersions);
    base.kimi_usage = await readKimiUsageSnapshot(ctx, snapshot.row.accountId ?? undefined);
    await touchHostAuthState(ctx.db, host.id, snapshot.row.id, snapshot.digest, engine);
    await touchHostAuthFields(ctx.db, host.id, snapshot.last_refresh, snapshot.digest, engine);
    return {
      ...base,
      account_pool: true,
      account_id: snapshot.row.accountId,
      canonical_digest: snapshot.digest,
      canonical_last_refresh: snapshot.last_refresh,
      canonical_generation: snapshot.canonical_generation,
      access_token_digest: snapshot.access_token_digest, expires_at: snapshot.expires_at,
      verification_state: 'verified',
      refresh_state: snapshot.refresh_state,
      status: extractDigest(payload, false) === snapshot.digest ? 'valid' : 'outdated',
      auth: snapshot.auth,
      usage: await readKimiUsage(ctx.db, snapshot.row.accountId!),
    };
  }
  const providedDigest = extractDigest(payload, false);
  const incomingLast =
    typeof payload.last_refresh === 'string' && payload.last_refresh.trim() !== ''
      ? payload.last_refresh.trim()
      : null;
  if (incomingLast) assertReasonableLastRefresh(incomingLast, 'last_refresh');

  const accountId = accountIdFrom(payload.account_id);
  const canonicalRow = await runnerValidation.resolveCanonicalPayload(engine, accountId);
  const validated = runnerValidation.validateCanonicalPayload(canonicalRow);
  const canonicalDigest = validated?.digest ?? null;
  const canonicalLast = validated?.last_refresh ?? null;
  const canonicalAuth = canonicalRow ? runnerValidation.canonicalAuthFromPayload(canonicalRow) : null;

  // Bump api_calls. Atomic SQL increment — avoids lost updates from concurrent
  // requests reading the same stale `host.apiCalls` snapshot.
  const apiCalls = await recordAuthCall(ctx.db, host);

  const versions = await projectVersions(engine);
  const quota = await readQuotaControls(
    ctx,
    host.vip === 1,
    engine,
    accountId ?? canonicalRow?.accountId ?? undefined,
  );
  const baseResponse: Record<string, unknown> = {
    account_pool: true,
    account_id: accountId ?? canonicalRow?.accountId ?? undefined,
    canonical_last_refresh: canonicalLast,
    canonical_digest: canonicalDigest,
    canonical_generation: canonicalRow?.generation ?? undefined,
    host: buildHostPayload(host, await readFleetEngineState(ctx.db)),
    api_calls: apiCalls,
    versions,
    ...quota,
    cdx_silent: versions.cdx_silent,
    engine,
  };
  const [chatgpt, claude, advice, pools] = await readAuthQuotaSnapshots(
    ctx,
    host,
    engine,
    accountId ?? canonicalRow?.accountId ?? undefined,
    quota.quota_unlimited === true,
  );
  if (engine === ENGINE_CODEX) baseResponse.chatgpt = chatgpt;
  else if (engine === ENGINE_CLAUDE) baseResponse.claude_usage = claude;
  baseResponse.quota_advice = quotaAdviceSnapshot(
    quota.quota_unlimited ? { ...advice, mode: 'off' } : advice,
    activeHostEngines(host.engines, await readFleetEngineState(ctx.db)),
    chatgpt,
    claude,
    pools,
  );

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
  // The presented login is one the server already holds for another account:
  // the scope was moved and its credentials file was not (a switch whose write
  // never happened). There is nothing to upload, and refresh times of two
  // different accounts say nothing about each other, so the bound account's
  // head is served whatever the local timestamp is.
  const boundAccountId = accountId ?? canonicalRow.accountId ?? undefined;
  const presentedAccountId =
    providedDigest && boundAccountId !== undefined
      ? await new ProviderAccountsService(ctx.db, ctx.keyring).accountOfDigest(engine, providedDigest)
      : undefined;
  if (presentedAccountId !== undefined && presentedAccountId !== boundAccountId) {
    return { ...baseResponse, status: 'outdated', auth: servedAuth, presented_account_id: presentedAccountId };
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
  const apiCalls = await recordAuthCall(ctx.db, host);

  const versions = await projectVersions(engine);
  const quota = await readQuotaControls(ctx, host.vip === 1, engine, accountIdFrom(payload.account_id));
  const baseResponse: Record<string, unknown> = {
    host: buildHostPayload(host, await readFleetEngineState(ctx.db)),
    api_calls: apiCalls,
    versions,
    ...quota,
    cdx_silent: versions.cdx_silent,
    engine,
  };
  const [chatgpt, claude, advice, pools] = await readAuthQuotaSnapshots(
    ctx,
    host,
    engine,
    accountIdFrom(payload.account_id),
    quota.quota_unlimited === true,
  );
  if (engine === ENGINE_CODEX) baseResponse.chatgpt = chatgpt;
  else if (engine === ENGINE_CLAUDE) baseResponse.claude_usage = claude;
  else if (engine === ENGINE_GROK)
    baseResponse.grok_usage = await readGrokUsageSnapshot(ctx, accountIdFrom(payload.account_id));
if (engine === ENGINE_KIMI)
    baseResponse.kimi_usage = await readKimiUsageSnapshot(ctx, accountIdFrom(payload.account_id));
  baseResponse.quota_advice = quotaAdviceSnapshot(
    quota.quota_unlimited ? { ...advice, mode: 'off' } : advice,
    activeHostEngines(host.engines, await readFleetEngineState(ctx.db)),
    chatgpt,
    claude,
    pools,
  );
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

  const fallbackPayload = payload;
  let discoveryError: unknown;
  try {
    // Same enrollment rule as POST /auth store: only a secure host may enroll an
    // unknown Claude subscription. An insecure host's unknown login is refused
    // definitively and gets the canonical account back.
    const { account: matchedAccount } = await new ProviderAccountsService(ctx.db, ctx.keyring).resolveCandidateDetailed(
      candidate,
      engine,
      accountIdFrom(payload.account_id),
      host.id,
      payload.session_id === undefined,
      false,
      host.secure === 1,
    );
    payload = { ...payload, account_id: matchedAccount.id };
  } catch (err) {
    if (
      !(err instanceof ValidationError) &&
      !(err instanceof ApiError && (err.code === 'account_removed' || err.code === 'account_enroll_insecure_host'))
    )
      throw err;
    discoveryError = err;
  }
  const accountId = accountIdFrom(payload.account_id);
  const canonicalRow = await runnerValidation.resolveCanonicalPayload(engine, accountId);
  const validated = runnerValidation.validateCanonicalPayload(canonicalRow);
  const canonicalDigest = validated?.digest ?? null;
  const canonicalLast = validated?.last_refresh ?? null;
  const canonicalAuth = canonicalRow ? runnerValidation.canonicalAuthFromPayload(canonicalRow) : null;
  const candidateLast = typeof candidate.last_refresh === 'string' ? candidate.last_refresh.trim() : '';
  const fallbackRow =
    canonicalRow ??
    (await runnerValidation.resolveCanonicalPayload(engine, accountIdFrom(fallbackPayload.account_id)));
  const fallbackValidated = runnerValidation.validateCanonicalPayload(fallbackRow);
  const candidateMatchesFailedCanonical =
    fallbackRow?.verificationState === 'failed' && fallbackValidated
      ? credentialPairMatches(
          runnerValidation.ensureAuthsFallback(candidate, engine),
          fallbackValidated.auth,
          engine,
        )
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
      await handleRetrieve(
        app,
        ctx,
        host,
        canonicalRow ? payload : fallbackPayload,
        engine,
        runnerValidation,
        projectVersions,
        authStore,
      ),
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
  if (discoveryError) return serveDefinitiveCandidateFallback();
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
      baseResponse.account_id = canonicalRow.accountId ?? undefined;
      baseResponse.account_pool = true;
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

  // A store attempt can change runner/version state even when it falls back
  // to retrieve. Do not reuse the pre-store bootstrap snapshot in either case.
  projectVersions.invalidate();
  try {
    const stored = await authStore.storeCandidate({
      auth: candidate,
      accountId,
      autoEnroll: host.secure === 1,
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
    return { ...baseResponse, ...stored, account_pool: true };
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
    // Nobody could say which account the candidate belongs to. The retrieve
    // fallback below is scoped to the caller's saved account and would hand
    // out that account's blob for an older-stamped candidate of another one.
    if (err instanceof ApiError && err.code === 'account_identity_unavailable') throw err;
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
        retrievePayloadWithCandidateFreshness(canonicalRow ? payload : fallbackPayload, candidateLast),
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
  const enroll = payload.enroll === true;
  // An explicit additional-account login never carries a lease or binding.
  if (enroll && (payload.session_id !== undefined || payload.account_id !== undefined))
    throw new ValidationError('enroll must not be combined with session_id or account_id', { param: 'enroll' });
  if (enroll && host.secure !== 1)
    throw new ForbiddenError('Insecure hosts may not enroll provider accounts', 'account_enroll_insecure_host');
  let stored;
  try {
    stored = await authStore.storeCandidate({
      auth: incoming,
      accountId: accountIdFrom(payload.account_id),
      accountHint: payload.session_id === undefined,
      enrollAccount: enroll,
      autoEnroll: host.secure === 1,
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
  const apiCalls = await recordAuthCall(ctx.db, host);

  const summary = await projectVersions(engine);
  const quota = await readQuotaControls(ctx, host.vip === 1, engine, stored.account_id);

  const response: Record<string, unknown> = {
    ...stored,
    account_pool: true,
    api_calls: apiCalls,
    versions: summary,
    ...quota,
    cdx_silent: summary.cdx_silent,
    host: buildHostPayload(host, await readFleetEngineState(ctx.db)),
  };
  const [chatgpt, claude, advice, pools] = await readAuthQuotaSnapshots(
    ctx,
    host,
    engine,
    stored.account_id,
    quota.quota_unlimited === true,
  );
  if (engine === ENGINE_CODEX) response.chatgpt = chatgpt;
  else if (engine === ENGINE_CLAUDE) response.claude_usage = claude;
  else if (engine === ENGINE_GROK) response.grok_usage = await readGrokUsageSnapshot(ctx, stored.account_id);
if (engine === ENGINE_KIMI) response.kimi_usage = await readKimiUsageSnapshot(ctx, stored.account_id);
  response.quota_advice = quotaAdviceSnapshot(
    quota.quota_unlimited ? { ...advice, mode: 'off' } : advice,
    activeHostEngines(host.engines, await readFleetEngineState(ctx.db)),
    chatgpt,
    claude,
    pools,
  );
  return response;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function resolvePublicBaseUrl(req: FastifyRequest, envBase: string | undefined): string {
  if (envBase) return envBase.replace(/\/+$/, '');
  const proto = headerString(req.headers['x-forwarded-proto']) ?? req.protocol ?? 'http';
  const host = headerString(req.headers['x-forwarded-host']) ?? headerString(req.headers.host) ?? 'localhost';
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

/**
 * The insecure window gates credential distribution, not fleet-managed content.
 * A `null` command says this request asked for no credentials at all — the
 * unattended cron tick's content-only bundle — and such a request is admitted
 * without opening an approval, exactly like `command=store` and like every
 * other content route (`/cron/check`, `/wrapper/v2/config`, `/skills`), which
 * have never been gated. Gating it instead produced an approval request per
 * host per tick on a fleet nobody was sitting at, and on Claude hosts the
 * resulting refusal stripped the very managed content the tick had come to
 * converge. It also means content-only traffic no longer slides the window:
 * a poller cannot hold its own access open.
 */
async function maybeEnforceInsecure(
  insecure: ReturnType<typeof createInsecureWindowService>,
  host: Host,
  command: string | null,
  requestIp?: string | null,
  unattended = false,
): Promise<Host> {
  if (command === null || host.secure === 1) return host;
  return insecure.enforce(host, command, requestIp, { unattended });
}

/** A wrapper marks its own background traffic (communicator scheduled resync). */
function unattendedRequest(req: { headers: Record<string, unknown> }): boolean {
  return req.headers['x-cxx-unattended'] === '1';
}

/**
 * `engines`/`engines_list` stay the host *assignment*: wrappers compare them
 * against their signed config for drift. Fleet suspension travels separately
 * in `fleet_disabled_engines`, so a switched-off engine is never mistaken for
 * a removed one. (No comments inside the literal: a contract test parses it.)
 */
function buildHostPayload(host: Host, fleet: FleetEngineState): Record<string, unknown> {
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
    lane_preference: host.lanePreference === 'spark' ? null : (host.lanePreference ?? null),
    model_override: host.modelOverride ?? null,
    reasoning_effort_override: host.reasoningEffortOverride ?? null,
    auto_update_override:
      host.autoUpdateOverride === null || host.autoUpdateOverride === undefined
        ? null
        : host.autoUpdateOverride === 1,
    last_cron_check: host.lastCronCheck ?? null,
    engines: host.engines,
    engines_list: hostEnginesList(host.engines),
    fleet_disabled_engines: disabledEngines(fleet),
    claude_client_version: host.claudeClientVersion ?? null,
    claude_client_version_override: host.claudeClientVersionOverride ?? null,
    claude_wrapper_version: host.claudeWrapperVersion ?? null,
    claude_auth_digest: host.claudeAuthDigest ?? null,
    claude_model_override: host.claudeModelOverride ?? null,
    claude_reasoning_effort_override: host.claudeReasoningEffortOverride ?? null,
    grok_last_refresh: host.grokLastRefresh ?? null,
    kimi_last_refresh: host.kimiLastRefresh ?? null,
    grok_client_version: host.grokClientVersion ?? null,
    kimi_client_version: host.kimiClientVersion ?? null,
    grok_client_version_override: host.grokClientVersionOverride ?? null,
    kimi_client_version_override: host.kimiClientVersionOverride ?? null,
    grok_wrapper_version: host.grokWrapperVersion ?? null,
    kimi_wrapper_version: host.kimiWrapperVersion ?? null,
    grok_auth_digest: host.grokAuthDigest ?? null,
    kimi_auth_digest: host.kimiAuthDigest ?? null,
    grok_model_override: host.grokModelOverride ?? null,
    kimi_model_override: host.kimiModelOverride ?? null,
    grok_reasoning_effort_override: host.grokReasoningEffortOverride ?? null,
    kimi_reasoning_effort_override: host.kimiReasoningEffortOverride ?? null,
  };
}

export async function readQuotaControls(
  ctx: RouteContext,
  vip: boolean,
  engine?: Engine,
  accountId?: number,
): Promise<{
  quota_hard_fail: boolean;
  quota_unlimited: boolean;
  quota_snapshot: Awaited<ReturnType<typeof quotaSnapshot>> | null;
  quota_limit_percent: number;
  quota_week_partition: 0 | 5 | 7;
}> {
  const settings = new SettingsService(ctx.db);
  const rawPartition = ((await settings.getString('quota_week_partition', 'off')) ?? 'off').trim();
  const unlimited = engine ? (await readQuotaPolicy(ctx.db, engine, accountId)).effective.unlimited : false;
  return {
    quota_unlimited: unlimited,
    quota_snapshot: engine && accountId ? await quotaSnapshot(ctx.db, accountId, engine) : null,
    quota_hard_fail: vip || unlimited ? false : await settings.getFlag('quota_hard_fail', true),
    quota_limit_percent: Math.max(50, Math.min(100, await settings.getInt('quota_limit_percent', 95))),
    quota_week_partition: rawPartition === '5' ? 5 : rawPartition === '7' ? 7 : 0,
  };
}

/** Alternative-engine advice uses an enabled verified account of that engine.
 * Never query another provider's history with the current engine's account ID.
 * Read only: advice does not acquire leases or refresh provider credentials. */
async function readAuthQuotaSnapshots(
  ctx: RouteContext,
  host: Host,
  engine: Engine,
  accountId: number | undefined,
  unlimited: boolean,
) {
  const advice = await readQuotaAdvice(new SettingsService(ctx.db));
  const enabled = activeHostEngines(host.engines, await readFleetEngineState(ctx.db));
  const alternatives = !unlimited && advice.mode !== 'off';
  const needed: Engine[] = [ENGINE_CODEX, ENGINE_CLAUDE].filter(
    (e) => e === engine || (alternatives && enabled.includes(e)),
  );
  const owner = ownerRuntimeFor(ctx.db);
  owner?.assertOwner();
  const snapshot = owner?.state.snapshot();
  const accounts =
    alternatives && snapshot
      ? snapshot
          .table('providerAccounts')
          .all()
          .filter(
            (a) =>
              needed.includes(a.engine as Engine) &&
              a.state === 'enabled' &&
              !a.mergedIntoAccountId &&
              a.payloadId !== null &&
              snapshot.table('authPayloads').get(a.payloadId)?.verificationState === 'verified',
          )
          .sort((a, b) => (b.lastSelectedAt ?? '').localeCompare(a.lastSelectedAt ?? '') || b.id - a.id)
          .map((a) => ({ id: a.id, engine: a.engine }))
      : alternatives
        ? await ctx.db
            .select({ id: providerAccounts.id, engine: providerAccounts.engine })
            .from(providerAccounts)
            .innerJoin(authPayloads, eq(providerAccounts.payloadId, authPayloads.id))
            .where(
              and(
                inArray(providerAccounts.engine, needed),
                eq(providerAccounts.state, 'enabled'),
                isNull(providerAccounts.mergedIntoAccountId),
                eq(authPayloads.verificationState, 'verified'),
              ),
            )
            .orderBy(desc(providerAccounts.lastSelectedAt), desc(providerAccounts.id))
        : [];
  // Pools (engines with more than one account) give the picker the whole
  // pool: the requesting engine relative to its bound account, the other
  // engine as a new launch would see it. Advisory: a failure omits the pool.
  const pools: { codex?: AdvicePool; claude?: AdvicePool } = {};
  if (alternatives) {
    const switches = new AccountSwitchService(ctx.db, ctx.keyring);
    for (const target of needed) {
      try {
        const view = await switches.poolView(target, target === engine ? (accountId ?? null) : null);
        if (view.accounts.length > 1) pools[target as 'codex' | 'claude'] = advicePool(view);
      } catch {
        // The single-account comparison stands without pool details.
      }
    }
  }
  const idFor = (target: Engine) =>
    target === engine
      ? accountId
      : (pools[target as 'codex' | 'claude']?.launch_account_id ?? accounts.find((a) => a.engine === target)?.id);
  const read = async (target: Engine) => {
    if (!needed.includes(target)) return { status: 'unavailable' };
    const id = idFor(target);
    if (target !== engine && id === undefined) return { status: 'unavailable' };
    return target === ENGINE_CODEX ? readChatgptSnapshot(ctx, id) : readClaudeSnapshot(ctx, id);
  };
  const [chatgpt, claude] = await Promise.all([read(ENGINE_CODEX), read(ENGINE_CLAUDE)]);
  return [chatgpt, claude, advice, pools] as const;
}

async function readChatgptSnapshot(ctx: RouteContext, accountId?: number): Promise<Record<string, unknown>> {
  const unavailable = {
    status: 'unavailable',
    active_quota_lane: 'normal',
  };
  try {
    const svc = new ChatGptUsageService(ctx.db, undefined, { env: ctx.env, keyring: ctx.keyring, accountId });
    const row = await svc.latest();
    if (!row) return unavailable;
    return {
      ...normalizeChatGptUsageSnapshot(row),
      ...(await svc.dailyUsage(row)),
      // Usage snapshots are account-wide, but the active lane is host state.
      // Shape it at the host response boundary instead of leaking the
      // normal-lane default baked into the account snapshot normalizer. The
      // `spark` lane is retired, so a stale stored preference still reads normal.
      active_quota_lane: 'normal',
    };
  } catch {
    return unavailable;
  }
}

async function readGrokUsageSnapshot(
  ctx: RouteContext,
  accountId?: number,
): Promise<Record<string, unknown>> {
  if (!accountId) return { status: 'unavailable' };
  try {
    return grokUsageAuthFields(await readGrokUsage(ctx.db, accountId));
  } catch {
    return { status: 'unavailable' };
  }
}
async function readKimiUsageSnapshot(
  ctx: RouteContext,
  accountId?: number,
): Promise<Record<string, unknown>> {
  if (!accountId) return { status: 'unavailable' };
  try {
    return kimiUsageAuthFields(await readKimiUsage(ctx.db, accountId));
  } catch {
    return { status: 'unavailable' };
  }
}

async function readClaudeSnapshot(ctx: RouteContext, accountId?: number): Promise<Record<string, unknown>> {
  // Statusline reports are already computed by Claude Code. A startup read
  // never polls the provider or renews fetched_at on an old observation.
  try {
    const row = await new ClaudeUsageService(ctx.db, accountId).latest();
    if (row) return { status: 'ok', ...normalizeClaudeUsageSnapshot(row) };
  } catch {
    // Usage telemetry is advisory; an unavailable snapshot must not break auth.
  }
  return { status: 'unavailable' };
}

function accountIdFrom(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new ValidationError('account_id must be a positive integer');
  return value;
}
function opaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(value))
    throw new ValidationError(`${field} must be an opaque 16-64 character identifier`);
  return value;
}

async function enforceAccountSession(
  accounts: ProviderAccountsService,
  hostId: number,
  engine: Engine,
  payload: Record<string, unknown>,
) {
  const submitted = accountIdFrom(payload.account_id);
  if (submitted !== undefined) payload.account_id = await accounts.canonicalId(submitted, engine);
  if (payload.session_id === undefined) return;
  const session = await accounts.session(hostId, engine, opaqueId(payload.session_id, 'session_id'));
  const accountId = accountIdFrom(payload.account_id);
  // A sibling process may have committed a live switch for this scope before
  // this wrapper's next heartbeat; the lease is authoritative.
  if (accountId !== undefined && accountId !== session.accountId && engine !== ENGINE_CLAUDE)
    throw new ValidationError('Account does not match session');
  payload.account_id = session.accountId;
}

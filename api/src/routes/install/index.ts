import {persistAuditLog} from '../../services/audit-log.js';
import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { requestHost } from '../../control-plane/state/admission.js';
import { HostSpawnService, hostSpawnCompletionScript } from '../../services/host-spawn.js';
import { createPooledAuthStoreService as createCanonicalAuthStoreService } from '../../services/pooled-auth-store.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { hosts as hostsTable, hostSpawns} from '../../db/schema.js';
import type { RouteContext } from '../index.js';
import { ApiError, NotFoundError, ValidationError } from '../../http/errors.js';
import { nowIso } from '../../util/timestamp.js';
import { decryptOrNull } from '../../security/secret-box.js';
import {
  buildInstallerLauncher,
  buildInstallerScript,
  buildSeedAuthScript,
  createInstallTokenService,
  shellErrorScript,
  tokenExpired,
} from '../../services/install-token.js';
import { hostEnginesList } from '../../services/host-engine-policy.js';
import { assertFleetEngineEnabledForAdmin, isFleetEngineEnabled } from '../../services/engine-switch.js';
import { ENGINE_LABELS } from '../../util/engine.js';
import { createRunnerValidationService } from '../../services/runner-validation.js';
import { createRunnerClient } from '../../services/runner-client.js';
import { wsPublisher } from '../../ws/publisher.js';

const INSTALL_TOKEN_RE = /^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/;
// Seed-auth tokens are minted as randomBytes(32).toString('hex') → 64 hex chars
// (see runner-proxy.seedCommand). The install-token shapes (32-hex / 36-char
// UUID) don't cover that, so seed routes need their own matcher; without the
// 64-hex alternative every freshly-minted seed token 404s before lookup.
const SEED_TOKEN_RE = /^(?:[a-f0-9]{32}|[a-f0-9]{64}|[a-f0-9-]{36})$/;

/**
 * Install / seed-auth flow.
 *
 *   GET  /install/:token        → emits the credential-free preflight launcher;
 *                                 consumes nothing
 *   POST /install/:token        → claims the single-use token and emits the
 *                                 full wrapper-installer bash script (the
 *                                 launcher calls this once preflight passes)
 *   GET|POST /install/v2/:token → aliases of /install/:token
 *   GET  /seed/auth/:token      → emits the auth-uploader bash script
 *   POST /seed/auth/:token      → host POSTs ~/.codex/auth.json here; the
 *                                 shared live-runner gate must verify it before
 *                                 it can become canonical.
 *   GET  /seed/v2/auth/:token   → alias of /seed/auth/:token
 *   POST /seed/v2/auth/:token   → alias of /seed/auth/:token
 *
 * Install tokens are 32 hex chars or a 36-char UUID; seed tokens additionally
 * accept the 64-hex shape; all are single-use and expire per the row's
 * `expires_at`.
 * Error scripts are served as HTTP 200 `text/x-shellscript` that prints the
 * message to stderr and exits 1, with the machine-readable reason in
 * `X-Installer-Error`. A 4xx would make `curl -fsSL … | sh` swallow the body
 * and hand `sh` an empty script, so the operator saw nothing at all.
 */
export async function registerInstallRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const installSvc = createInstallTokenService({ db: ctx.db, keyring: ctx.keyring });
  const runnerValidation = createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring });
  const authStore = createCanonicalAuthStoreService({
    db: ctx.db,
    keyring: ctx.keyring,
    runnerValidation,
    runner: createRunnerClient({ env: ctx.env }),
  });

  type InstallError = { message: string; code: string; expiresAt?: string };
  type ResolvedInstall = {
    row: NonNullable<Awaited<ReturnType<typeof installSvc.findInstall>>>;
    host: typeof hostsTable.$inferSelect;
    baseUrl: string;
    body: string;
  };

  // Every gate runs on both the non-consuming GET and the consuming POST, and
  // the full script is built on both, so the launcher only ever starts for an
  // installer that its POST would actually serve.
  const resolveInstall = async (token: string): Promise<ResolvedInstall | InstallError> => {
    if (!INSTALL_TOKEN_RE.test(token)) return { message: 'Installer not found', code: 'installer_not_found' };
    const row = await installSvc.findInstall(token);
    if (!row) return { message: 'Installer not found', code: 'installer_not_found' };
    if (row.usedAt) return { message: 'Installer already used', code: 'installer_used', expiresAt: row.expiresAt };
    if (tokenExpired(row.expiresAt))
      return { message: 'Installer expired', code: 'installer_expired', expiresAt: row.expiresAt };

    const owner=ownerRuntimeFor(ctx.db);
    const current=owner?.state.snapshot().hosts.get(row.hostId);
    const host = owner ? current ? requestHost(current,row.apiKey) : undefined : (await ctx.db.select().from(hostsTable).where(eq(hostsTable.id,row.hostId)).limit(1))[0];
    if (!host) return { message: 'Installer host missing', code: 'installer_host_missing' };
    if ((host.status && host.status !== 'active') || (host.expiresAt && tokenExpired(host.expiresAt))) {
      return { message: 'Installer host unavailable', code: 'installer_host_unavailable' };
    }
    if (!hostEnginesList(host.engines).includes(row.engine)) {
      return { message: 'Installer engine no longer assigned to host', code: 'engine_disabled', expiresAt: row.expiresAt };
    }
    // Checked before the token is consumed, so it still works once the engine
    // is switched back on.
    if (!(await isFleetEngineEnabled(ctx.db, row.engine))) {
      return { message: `${ENGINE_LABELS[row.engine]} is disabled fleet-wide by the administrator`, code: 'engine_disabled', expiresAt: row.expiresAt };
    }

    let apiKey = row.apiKey;
    if (!apiKey) {
      const fallback = decryptOrNull(host.apiKeyEnc ?? null, ctx.keyring);
      if (fallback) apiKey = fallback;
    }
    const baseUrl = resolveBaseUrl(row.baseUrl, ctx);
    if (!baseUrl) return { message: 'Installer base URL invalid', code: 'installer_base_url_invalid', expiresAt: row.expiresAt };

    const spawnRows = owner ? owner.state.snapshot().table('hostSpawns').by('targetHostId',host.id) : await ctx.db.select().from(hostSpawns).where(eq(hostSpawns.targetHostId, host.id)).limit(1);
    if (spawnRows.length) {
      const source = owner ? owner.state.snapshot().hosts.get(spawnRows[0]!.sourceHostId) : (await ctx.db.select().from(hostsTable).where(eq(hostsTable.id,spawnRows[0]!.sourceHostId)))[0];
      if (!(await new HostSpawnService(ctx).enabled()) || !source || source.status !== 'active' || source.vip !== 1)
        return { message: 'System spawn is disabled or source VIP revoked', code: 'host_spawn_disabled' };
    }

    let body: string;
    try {
      body = buildInstallerScript({
        fqdn: host.fqdn,
        apiKey,
        baseUrl,
        engine: row.engine,
        enginesList: hostEnginesList(host.engines),
        allowInsecure: host.curlInsecure === 1,
      });
    } catch (err) {
      return {
        message: err instanceof Error ? err.message : 'installer build failed',
        code: 'installer_build_failed',
        expiresAt: row.expiresAt,
      };
    }
    if (spawnRows.length) {
      body = body.replace('  exit 0\nfi\n\nui_result_fail', `${hostSpawnCompletionScript()}
  exit 0
fi

ui_result_fail`);
    }
    return { row, host, baseUrl, body };
  };

  // GET serves the credential-free preflight launcher and consumes nothing:
  // a missing prerequisite on the target, a link scanner or a second look at
  // the URL cannot burn the single-use token.
  const installLauncherHandler = async (token: string, path: string, reply: FastifyReply): Promise<void> => {
    const resolved = await resolveInstall(token);
    if ('code' in resolved) return shellishError(reply, resolved.message, resolved.code, resolved.expiresAt);
    const { row, host, baseUrl } = resolved;
    const body = buildInstallerLauncher({
      fqdn: host.fqdn,
      engine: row.engine,
      installUrl: `${baseUrl}${path}${token}`,
      allowInsecure: host.curlInsecure === 1,
    });
    emitInstaller(reply, body, 200, row.expiresAt);
  };

  // POST is the claim: it atomically consumes the token and emits the full
  // installer, which embeds the host API key.
  const installClaimHandler = async (token: string, reply: FastifyReply): Promise<void> => {
    const resolved = await resolveInstall(token);
    if ('code' in resolved) return shellishError(reply, resolved.message, resolved.code, resolved.expiresAt);
    const { row, host, body } = resolved;
    const claimed = await installSvc.markInstallUsed(row.id);
    if (!claimed) return shellishError(reply, 'Installer already used', 'installer_used', row.expiresAt);
    if (!ownerRuntimeFor(ctx.db)) await persistAuditLog(ctx.db, {
      hostId: row.hostId,
      action: 'install.v2.token.consume',
      details: JSON.stringify({ token: token.slice(0, 8) + '…', engine: row.engine }),
      createdAt: nowIso(),
    });
    // The host list shows installer state; tell open consoles it just changed.
    wsPublisher.publish('host.updated', { id: host.id, fqdn: host.fqdn, engine: row.engine });

    emitInstaller(reply, body, 200, row.expiresAt);
  };

  app.get<{ Params: { token: string } }>('/install/:token', async (req, reply) =>
    installLauncherHandler(req.params.token, '/install/', reply),
  );
  app.get<{ Params: { token: string } }>('/install/v2/:token', async (req, reply) =>
    installLauncherHandler(req.params.token, '/install/v2/', reply),
  );
  app.post<{ Params: { token: string } }>('/install/:token', async (req, reply) =>
    installClaimHandler(req.params.token, reply),
  );
  app.post<{ Params: { token: string } }>('/install/v2/:token', async (req, reply) =>
    installClaimHandler(req.params.token, reply),
  );

  const seedScriptHandler = async (token: string, reply: FastifyReply): Promise<void> => {
    if (!SEED_TOKEN_RE.test(token)) return shellishSeedError(reply, 'Seed token not found', 'seed_not_found');
    const row = await installSvc.findSeed(token);
    if (!row) return shellishSeedError(reply, 'Seed token not found', 'seed_not_found');
    if (row.usedAt) return shellishSeedError(reply, 'Seed token already used', 'seed_used', row.expiresAt);
    if (tokenExpired(row.expiresAt))
      return shellishSeedError(reply, 'Seed token expired', 'seed_expired', row.expiresAt);
    if (!(await isFleetEngineEnabled(ctx.db, row.engine))) {
      return shellishSeedError(reply, `${ENGINE_LABELS[row.engine]} is disabled fleet-wide by the administrator`, 'engine_disabled', row.expiresAt);
    }
    const baseUrl = resolveBaseUrl(row.baseUrl, ctx);
    if (!baseUrl)
      return shellishSeedError(reply, 'Seed base URL invalid', 'seed_base_url_invalid', row.expiresAt);

    let body: string;
    try {
      body = buildSeedAuthScript({ baseUrl, token: row.token, engine: row.engine });
    } catch (err) {
      return shellishSeedError(
        reply,
        err instanceof Error ? err.message : 'seed build failed',
        'seed_build_failed',
        row.expiresAt,
      );
    }
    emitSeed(reply, body, 200, row.expiresAt);
  };

  app.get<{ Params: { token: string } }>('/seed/auth/:token', async (req, reply) =>
    seedScriptHandler(req.params.token, reply),
  );
  app.get<{ Params: { token: string } }>('/seed/v2/auth/:token', async (req, reply) =>
    seedScriptHandler(req.params.token, reply),
  );

  const seedStoreHandler = async (token: string, body: unknown): Promise<Record<string, unknown>> => {
    if (!SEED_TOKEN_RE.test(token)) throw new NotFoundError('Seed token not found');
    const row = await installSvc.findSeed(token);
    if (!row) throw new NotFoundError('Seed token not found');
    if (row.usedAt) throw new ApiError('Seed token already used', { status: 410, code: 'seed_used' });
    if (tokenExpired(row.expiresAt)) {
      throw new ApiError('Seed token expired', { status: 410, code: 'seed_expired' });
    }
    await assertFleetEngineEnabledForAdmin(ctx.db, row.engine);

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('auth payload must be valid JSON', { param: 'auth' });
    }
    const decoded = body as Record<string, unknown>;
    const candidate = decoded.auth ?? decoded;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ValidationError('auth payload must be an object', { param: 'auth' });
    }

    // Reserve only after cheap shape validation. Keep the atomic reservation
    // while the runner/store executes, but release it on any failure so a
    // transient runner outage or rejected malformed credential does not burn
    // the single-use recovery token permanently.
    const claimed = await installSvc.markSeedUsed(row.id);
    if (!claimed) throw new ApiError('Seed token already used', { status: 410, code: 'seed_used' });

    const engine = row.engine;
    let stored;
    try {
      stored = await authStore.storeCandidate({
        auth: candidate as Record<string, unknown>,
        accountId: row.accountId ?? undefined,
        enrollAccount: row.accountId == null,
        engine,
        sourceHostId: null,
        requireLastRefresh: false,
        logAction: 'auth.seed.v2.consume',
        logDetails: { token: token.slice(0, 8) + '…' },
        sourceKind: 'seed',
      });
    } catch (err) {
      // An unsafe runner readback can mean the candidate's refresh token was
      // consumed and replacement bytes were already retained as a pending
      // canonical lineage.  Never reopen a one-time seed after that ambiguous
      // side effect; an ordinary validation/transport failure remains safely
      // retryable.
      if (!(err instanceof ApiError && err.code === 'runner_updated_auth_invalid')) {
        await installSvc.releaseSeed(row.id);
      }
      throw err;
    }

    return {
      ...stored,
    };
  };

  app.post<{ Params: { token: string } }>('/seed/auth/:token', async (req) =>
    seedStoreHandler(req.params.token, req.body),
  );
  app.post<{ Params: { token: string } }>('/seed/v2/auth/:token', async (req) =>
    seedStoreHandler(req.params.token, req.body),
  );
}

function resolveBaseUrl(tokenBaseUrl: string | null, ctx: RouteContext): string {
  const candidates = [tokenBaseUrl, ctx.env.PUBLIC_BASE_URL].filter(Boolean) as string[];
  for (const c of candidates) {
    const trimmed = c.trim().replace(/\/+$/, '');
    if (trimmed && trimmed !== 'http:' && trimmed !== 'https:') return trimmed;
  }
  return '';
}

function emitInstaller(reply: FastifyReply, body: string, status: number, expiresAt?: string): void {
  reply.envelopeRaw = true;
  reply.header('content-type', 'text/x-shellscript; charset=utf-8');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'no-store, must-revalidate');
  if (expiresAt) reply.header('x-installer-expires-at', expiresAt);
  reply.status(status).send(body);
}

function emitSeed(reply: FastifyReply, body: string, status: number, expiresAt?: string): void {
  reply.envelopeRaw = true;
  reply.header('content-type', 'text/x-shellscript; charset=utf-8');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'no-store, must-revalidate');
  if (expiresAt) reply.header('x-seed-expires-at', expiresAt);
  reply.status(status).send(body);
}

function shellishError(reply: FastifyReply, message: string, code: string, expiresAt?: string): void {
  reply.header('x-installer-error', code);
  emitInstaller(reply, shellErrorScript(message), 200, expiresAt);
}

function shellishSeedError(reply: FastifyReply, message: string, code: string, expiresAt?: string): void {
  reply.header('x-installer-error', code);
  emitSeed(reply, shellErrorScript(message), 200, expiresAt);
}

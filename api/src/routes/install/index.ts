import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  hosts as hostsTable,
  logs as logsTable,
  hostAuthDigests,
  hostAuthStates,
} from '../../db/schema.js';
import type { RouteContext } from '../index.js';
import { ApiError, NotFoundError, ValidationError } from '../../http/errors.js';
import { nowIso } from '../../util/timestamp.js';
import { decryptOrNull } from '../../security/secret-box.js';
import {
  buildInstallerScript,
  buildSeedAuthScript,
  createInstallTokenService,
  shellErrorScript,
  tokenExpired,
} from '../../services/install-token.js';
import { hostEnginesList } from '../../services/host-engine-policy.js';
import { createRunnerValidationService } from '../../services/runner-validation.js';
import { createRunnerClient } from '../../services/runner-client.js';
import { createCanonicalAuthStoreService } from '../../services/canonical-auth-store.js';

const INSTALL_TOKEN_RE = /^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/;
// Seed-auth tokens are minted as randomBytes(32).toString('hex') → 64 hex chars
// (see runner-proxy.seedCommand). The install-token shapes (32-hex / 36-char
// UUID) don't cover that, so seed routes need their own matcher; without the
// 64-hex alternative every freshly-minted seed token 404s before lookup.
const SEED_TOKEN_RE = /^(?:[a-f0-9]{32}|[a-f0-9]{64}|[a-f0-9-]{36})$/;

/**
 * Install / seed-auth flow.
 *
 *   GET  /install/:token        → emits the wrapper-installer bash script
 *   GET  /install/v2/:token     → alias of /install/:token
 *   GET  /seed/auth/:token      → emits the auth-uploader bash script
 *   POST /seed/auth/:token      → host POSTs ~/.codex/auth.json here; we
 *                                 persist it as a canonical auth payload
 *                                 (skipping runner verification).
 *   GET  /seed/v2/auth/:token   → alias of /seed/auth/:token
 *   POST /seed/v2/auth/:token   → alias of /seed/auth/:token
 *
 * Tokens are UUID4 strings; single-use; expire per the row's `expires_at`.
 * Bash error scripts get a `text/x-shellscript` content type with non-200
 * status, so the wrapper's `curl | sh` surfaces the message in the user's
 * terminal.
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

  const installHandler = async (token: string, reply: FastifyReply): Promise<void> => {
    if (!INSTALL_TOKEN_RE.test(token)) return shellishError(reply, 'Installer not found', 404);
    const row = await installSvc.findInstall(token);
    if (!row) return shellishError(reply, 'Installer not found', 404);
    if (row.usedAt) return shellishError(reply, 'Installer already used', 410, row.expiresAt);
    if (tokenExpired(row.expiresAt)) return shellishError(reply, 'Installer expired', 410, row.expiresAt);

    const hostRows = await ctx.db.select().from(hostsTable).where(eq(hostsTable.id, row.hostId)).limit(1);
    const host = hostRows[0];
    if (!host) return shellishError(reply, 'Installer host missing', 404);

    let apiKey = row.apiKey;
    if (!apiKey) {
      const fallback = decryptOrNull(host.apiKeyEnc ?? null, ctx.keyring);
      if (fallback) apiKey = fallback;
    }
    const baseUrl = resolveBaseUrl(row.baseUrl, ctx);
    if (!baseUrl) return shellishError(reply, 'Installer base URL invalid', 500, row.expiresAt);

    const claimed = await installSvc.markInstallUsed(row.id);
    if (!claimed) return shellishError(reply, 'Installer already used', 410, row.expiresAt);
    await ctx.db.insert(logsTable).values({
      hostId: row.hostId,
      action: 'install.v2.token.consume',
      details: JSON.stringify({ token: token.slice(0, 8) + '…', engine: row.engine }),
      createdAt: nowIso(),
    });

    let body: string;
    try {
      body = buildInstallerScript({
        fqdn: host.fqdn,
        apiKey,
        baseUrl,
        engine: row.engine,
        enginesList: hostEnginesList(host.engines),
      });
    } catch (err) {
      return shellishError(
        reply,
        err instanceof Error ? err.message : 'installer build failed',
        500,
        row.expiresAt,
      );
    }
    emitInstaller(reply, body, 200, row.expiresAt);
  };

  app.get<{ Params: { token: string } }>('/install/:token', async (req, reply) =>
    installHandler(req.params.token, reply),
  );
  app.get<{ Params: { token: string } }>('/install/v2/:token', async (req, reply) =>
    installHandler(req.params.token, reply),
  );

  const seedScriptHandler = async (token: string, reply: FastifyReply): Promise<void> => {
    if (!SEED_TOKEN_RE.test(token)) return shellishSeedError(reply, 'Seed token not found', 404);
    const row = await installSvc.findSeed(token);
    if (!row) return shellishSeedError(reply, 'Seed token not found', 404);
    if (row.usedAt) return shellishSeedError(reply, 'Seed token already used', 410, row.expiresAt);
    if (tokenExpired(row.expiresAt))
      return shellishSeedError(reply, 'Seed token expired', 410, row.expiresAt);
    const baseUrl = resolveBaseUrl(row.baseUrl, ctx);
    if (!baseUrl) return shellishSeedError(reply, 'Seed base URL invalid', 500, row.expiresAt);

    let body: string;
    try {
      body = buildSeedAuthScript({ baseUrl, token: row.token, engine: row.engine });
    } catch (err) {
      return shellishSeedError(
        reply,
        err instanceof Error ? err.message : 'seed build failed',
        500,
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

    // Claim the token atomically before doing any work: this is the only thing
    // guarding against a concurrent/replayed request also being accepted.
    const claimed = await installSvc.markSeedUsed(row.id);
    if (!claimed) throw new ApiError('Seed token already used', { status: 410, code: 'seed_used' });

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('auth payload must be valid JSON', { param: 'auth' });
    }
    const decoded = body as Record<string, unknown>;
    const candidate = decoded.auth ?? decoded;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ValidationError('auth payload must be an object', { param: 'auth' });
    }

    const engine = row.engine;
    const stored = await authStore.storeCandidate({
      auth: candidate as Record<string, unknown>,
      engine,
      sourceHostId: null,
      requireLastRefresh: false,
      logAction: 'auth.seed.v2.consume',
      logDetails: { token: token.slice(0, 8) + '…' },
    });

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

function shellishError(reply: FastifyReply, message: string, status = 400, expiresAt?: string): void {
  emitInstaller(reply, shellErrorScript(message), status, expiresAt);
}

function shellishSeedError(reply: FastifyReply, message: string, status = 400, expiresAt?: string): void {
  emitSeed(reply, shellErrorScript(message), status, expiresAt);
}

// Silence unused-import warnings for tables we reference indirectly via cleanup hooks
// when this module evolves.
void hostAuthDigests;
void hostAuthStates;

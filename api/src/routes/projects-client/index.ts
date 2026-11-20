/**
 * Host-facing routes:
 *   /skills, /skills/retrieve, /skills/store
 *   /agents/retrieve, /config/retrieve
 *   /claude/:kind, /claude/:kind/retrieve
 *
 * Knowledge (projects, host memory, shared memory) is MCP-only for hosts; the
 * former REST mirrors under /projects, /mcp/memories and /shared-memories were
 * removed (2026-11-20).
 *
 * All endpoints require `app.requireHost` and source-host attribution is
 * carried into the underlying services via `req.authHost`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteContext } from '../index.js';
import { ok } from '../../http/reply.js';
import { HostSkillsService } from '../../services/host-skills.js';
import { HostAgentsService } from '../../services/host-agents.js';
import { hostWithCallerWrapper } from '../../services/host-wrapper-capabilities.js';
import { HostClaudeArtifactsService } from '../../services/host-claude-artifacts.js';
import { normalizeKind } from '../../services/claude-frontmatter.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../../util/engine.js';
import { resolveRequestEngine } from '../../util/engine-resolution.js';
import { UnauthorizedError, ValidationError } from '../../http/errors.js';
import { assertHostEngineEnabled } from '../../services/host-engine-policy.js';
import { readFleetEngineState } from '../../services/engine-switch.js';
import type { Database } from '../../db/client.js';

/**
 * Resolve body, query and header together, matching the startup sync surface.
 * Claude-native routes have an unambiguous engine even without a hint.
 */
function extractEngine(req: FastifyRequest, fallback: Engine = ENGINE_CODEX): Engine {
  const payload = typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : undefined;
  return resolveRequestEngine(req, payload, {
    fallback,
    legacyUserAgentInference: fallback === ENGINE_CODEX,
  });
}

async function requireClaudeHost(req: FastifyRequest, db: Database) {
  const engine = extractEngine(req, ENGINE_CLAUDE);
  if (engine !== ENGINE_CLAUDE) {
    throw new ValidationError('Claude artifacts require engine "claude"', { param: 'engine' });
  }
  return requireEngineHost(req, engine, db);
}

function requireHost(req: FastifyRequest) {
  if (!req.authHost) throw new UnauthorizedError('Invalid API key', 'invalid_api_key');
  return req.authHost;
}

async function requireEngineHost(req: FastifyRequest, engine: Engine, db: Database) {
  const host = requireHost(req);
  assertHostEngineEnabled(host, engine, await readFleetEngineState(db));
  return host;
}

export async function registerProjectsClientRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const skills = new HostSkillsService(ctx.db);
  const agents = new HostAgentsService(ctx.db, {
    publicBaseUrl: ctx.env.PUBLIC_BASE_URL ?? null,
    keyring: ctx.keyring,
  });
  const claudeArtifacts = new HostClaudeArtifactsService(ctx.db);
  const auth = app.requireHost;

  // ─── Skills ───────────────────────────────────────────────────────────
  app.get('/skills', { preHandler: auth }, async (req) => {
    const engine = extractEngine(req);
    return ok(await skills.listSkills(await requireEngineHost(req, engine, ctx.db), engine));
  });
  app.post('/skills/retrieve', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    const slug = String(payload['slug'] ?? payload['filename'] ?? '');
    const sha = typeof payload['sha256'] === 'string' ? (payload['sha256'] as string) : null;
    const engine = extractEngine(req);
    return ok(await skills.retrieve(slug, sha, await requireEngineHost(req, engine, ctx.db), engine));
  });
  app.post('/skills/store', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    const engine = extractEngine(req);
    return ok(await skills.store(payload, await requireEngineHost(req, engine, ctx.db)));
  });

  // ─── Agents + client config ───────────────────────────────────────────
  app.post('/agents/retrieve', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    const sha = typeof payload['sha256'] === 'string' ? (payload['sha256'] as string) : null;
    const engine = extractEngine(req);
    const result = await agents.retrieve(sha, await requireEngineHost(req, engine, ctx.db), engine);
    return ok({ ...result, engine });
  });
  app.post('/config/retrieve', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    const sha = typeof payload['sha256'] === 'string' ? (payload['sha256'] as string) : null;
    const engine = extractEngine(req);
    const host = await requireEngineHost(req, engine, ctx.db);
    const result = await agents.retrieveConfig(sha, hostWithCallerWrapper(host, engine, req.headers['x-wrapper-version']), engine, {
      home: typeof payload['home'] === 'string' ? payload['home'] : null,
      username: typeof payload['username'] === 'string' ? payload['username'] : null,
    });
    return ok({ ...result, engine });
  });

  // ─── Claude artifacts (subagents / commands / output-styles) ──────────
  app.get('/claude/:kind', { preHandler: auth }, async (req) => {
    const kind = normalizeKind((req.params as { kind: string }).kind);
    return ok(await claudeArtifacts.list(kind, await requireClaudeHost(req, ctx.db), ENGINE_CLAUDE));
  });
  app.post('/claude/:kind/retrieve', { preHandler: auth }, async (req) => {
    const kind = normalizeKind((req.params as { kind: string }).kind);
    const payload = (req.body as Record<string, unknown>) ?? {};
    const slug = String(payload['slug'] ?? payload['filename'] ?? '');
    const sha = typeof payload['sha256'] === 'string' ? (payload['sha256'] as string) : null;
    return ok(await claudeArtifacts.retrieve(kind, slug, sha, await requireClaudeHost(req, ctx.db)));
  });
  // No host-originated store: Claude artifacts are admin-authored fleet-wide.
  // The host surface is read-only (list / retrieve / bundle).
}

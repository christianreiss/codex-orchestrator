/**
 * Host-facing routes:
 *   GET /skills
 *
 * AGENTS.md, client config, skill bodies and Claude artifacts reach hosts
 * through `POST /sync/bootstrap` (and skills also through MCP); the per-item
 * REST retrieve/store routes that pre-bundle wrappers used were removed
 * (2026-11-20).
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
import { ENGINE_CODEX, type Engine } from '../../util/engine.js';
import { resolveRequestEngine } from '../../util/engine-resolution.js';
import { UnauthorizedError } from '../../http/errors.js';
import { assertHostEngineEnabled } from '../../services/host-engine-policy.js';
import { readFleetEngineState } from '../../services/engine-switch.js';
import type { Database } from '../../db/client.js';

/** Resolve body, query and header together, matching the startup sync surface. */
function extractEngine(req: FastifyRequest, fallback: Engine = ENGINE_CODEX): Engine {
  const payload = typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : undefined;
  return resolveRequestEngine(req, payload, {
    fallback,
    legacyUserAgentInference: fallback === ENGINE_CODEX,
  });
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
  const auth = app.requireHost;

  // ─── Skills ───────────────────────────────────────────────────────────
  app.get('/skills', { preHandler: auth }, async (req) => {
    const engine = extractEngine(req);
    return ok(await skills.listSkills(await requireEngineHost(req, engine, ctx.db), engine));
  });
}

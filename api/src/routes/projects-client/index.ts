/**
 * Host-facing routes:
 *   /projects, /projects/:slug, /projects/:slug/{about,roster,changes,…}
 *   /skills, /skills/retrieve, /skills/store
 *   /agents/retrieve, /config/retrieve
 *   /mcp/memories/{store,delete,retrieve,search}, /mcp/memories/:id
 *
 * All endpoints require `app.requireHost` and source-host attribution is
 * carried into the underlying services via `req.authHost`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteContext } from '../index.js';
import { ok } from '../../http/reply.js';
import { HostProjectsService } from '../../services/host-projects.js';
import { HostSkillsService } from '../../services/host-skills.js';
import { HostAgentsService } from '../../services/host-agents.js';
import { McpMemoriesService } from '../../services/mcp-memories.js';
import { ENGINE_CODEX, isEngine, type Engine } from '../../util/engine.js';
import { UnauthorizedError } from '../../http/errors.js';

function extractEngine(input: unknown): Engine {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const e = (input as Record<string, unknown>)['engine'];
    if (isEngine(e)) return e as Engine;
  }
  return ENGINE_CODEX;
}

function parseSlug(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function requireHost(req: FastifyRequest) {
  if (!req.authHost) throw new UnauthorizedError('Invalid API key', 'invalid_api_key');
  return req.authHost;
}

export async function registerProjectsClientRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const projects = new HostProjectsService(ctx.db);
  const skills = new HostSkillsService(ctx.db);
  const agents = new HostAgentsService(ctx.db, {
    publicBaseUrl: ctx.env.PUBLIC_BASE_URL ?? null,
    keyring: ctx.keyring,
  });
  const memories = new McpMemoriesService(ctx.db);
  const auth = app.requireHost;

  // ─── Projects ─────────────────────────────────────────────────────────
  app.get('/projects', { preHandler: auth }, async (req) => ok(await projects.listProjects(requireHost(req))));
  app.post('/projects', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    return ok(await projects.createProject(payload, requireHost(req)));
  });
  app.get('/projects/:slug/bootstrap', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.bootstrap(slug, requireHost(req)));
  });
  app.get('/projects/:slug', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.projectDetail(slug, requireHost(req)));
  });
  app.post('/projects/:slug/about', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.updateAbout(slug, (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.post('/projects/:slug/roster', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.updateRoster(slug, (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.get('/projects/:slug/changes', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    const since = Number((req.query as { since?: string })?.since ?? 0);
    return ok(await projects.listChanges(slug, Number.isFinite(since) ? Math.max(0, since) : 0, requireHost(req)));
  });

  // Notes
  app.get('/projects/:slug/notes', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.listNotes(slug, requireHost(req)));
  });
  app.post('/projects/:slug/notes', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.upsertNote(slug, null, (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.post('/projects/:slug/notes/:id', { preHandler: auth }, async (req) => {
    const { slug, id } = req.params as { slug: string; id: string };
    return ok(await projects.upsertNote(parseSlug(slug), Number(id), (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.delete('/projects/:slug/notes/:id', { preHandler: auth }, async (req) => {
    const { slug, id } = req.params as { slug: string; id: string };
    return ok(await projects.deleteNote(parseSlug(slug), Number(id), requireHost(req)));
  });

  // Todos
  app.get('/projects/:slug/todos', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.listTodos(slug, requireHost(req)));
  });
  app.post('/projects/:slug/todos', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.createTodo(slug, (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.post('/projects/:slug/todos/:id', { preHandler: auth }, async (req) => {
    const { slug, id } = req.params as { slug: string; id: string };
    return ok(await projects.updateTodo(parseSlug(slug), Number(id), (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.post('/projects/:slug/todos/:id/done', { preHandler: auth }, async (req) => {
    const { slug, id } = req.params as { slug: string; id: string };
    return ok(await projects.setTodoDone(parseSlug(slug), Number(id), true, requireHost(req)));
  });
  app.post('/projects/:slug/todos/:id/undone', { preHandler: auth }, async (req) => {
    const { slug, id } = req.params as { slug: string; id: string };
    return ok(await projects.setTodoDone(parseSlug(slug), Number(id), false, requireHost(req)));
  });
  app.delete('/projects/:slug/todos/:id', { preHandler: auth }, async (req) => {
    const { slug, id } = req.params as { slug: string; id: string };
    return ok(await projects.deleteTodo(parseSlug(slug), Number(id), requireHost(req)));
  });

  // Files
  app.get('/projects/:slug/files', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.listFiles(slug, requireHost(req)));
  });
  app.post('/projects/:slug/files', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.upsertFile(slug, (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.delete('/projects/:slug/files/:id', { preHandler: auth }, async (req) => {
    const { slug, id } = req.params as { slug: string; id: string };
    return ok(await projects.deleteFile(parseSlug(slug), Number(id), requireHost(req)));
  });

  // Feedback
  app.get('/projects/:slug/feedback', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.listFeedback(slug, requireHost(req)));
  });
  app.post('/projects/:slug/feedback', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.createFeedback(slug, (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });

  // ─── Skills ───────────────────────────────────────────────────────────
  app.get('/skills', { preHandler: auth }, async (req) => {
    const engine = extractEngine(req.query);
    return ok(await skills.listSkills(requireHost(req), engine));
  });
  app.post('/skills/retrieve', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    const slug = String(payload['slug'] ?? payload['filename'] ?? '');
    const sha = typeof payload['sha256'] === 'string' ? (payload['sha256'] as string) : null;
    return ok(await skills.retrieve(slug, sha, requireHost(req)));
  });
  app.post('/skills/store', { preHandler: auth }, async (req) => {
    return ok(await skills.store((req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });

  // ─── Agents + client config ───────────────────────────────────────────
  app.post('/agents/retrieve', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    const sha = typeof payload['sha256'] === 'string' ? (payload['sha256'] as string) : null;
    const engine = extractEngine(payload);
    const result = await agents.retrieve(sha, requireHost(req), engine);
    return ok({ ...result, engine });
  });
  app.post('/config/retrieve', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    const sha = typeof payload['sha256'] === 'string' ? (payload['sha256'] as string) : null;
    const engine = extractEngine(payload);
    const result = await agents.retrieveConfig(sha, requireHost(req), engine, {
      home: typeof payload['home'] === 'string' ? payload['home'] : null,
      username: typeof payload['username'] === 'string' ? payload['username'] : null,
    });
    return ok({ ...result, engine });
  });

  // ─── MCP memories (host-key) ──────────────────────────────────────────
  app.post('/mcp/memories/store', { preHandler: auth }, async (req) =>
    ok(await memories.store((req.body as Record<string, unknown>) ?? {}, requireHost(req))),
  );
  app.post('/mcp/memories/delete', { preHandler: auth }, async (req) =>
    ok(await memories.delete((req.body as Record<string, unknown>) ?? {}, requireHost(req))),
  );
  app.delete('/mcp/memories/:id', { preHandler: auth }, async (req) => {
    const id = parseSlug((req.params as { id: string }).id);
    return ok(await memories.delete({ id }, requireHost(req)));
  });
  app.post('/mcp/memories/retrieve', { preHandler: auth }, async (req) =>
    ok(await memories.retrieve((req.body as Record<string, unknown>) ?? {}, requireHost(req))),
  );
  app.post('/mcp/memories/search', { preHandler: auth }, async (req) =>
    ok(await memories.search((req.body as Record<string, unknown>) ?? {}, requireHost(req))),
  );
}

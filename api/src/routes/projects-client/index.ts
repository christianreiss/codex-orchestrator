/**
 * Host-facing routes:
 *   /projects, /projects/:slug, /projects/:slug/{about,roster,changes,…}
 *   /projects/:slug/memories, /projects/:slug/memories/search,
 *     /projects/:slug/memories/:key
 *   /skills, /skills/retrieve, /skills/store
 *   /agents/retrieve, /config/retrieve
 *   /mcp/memories/{store,delete,retrieve,search}, /mcp/memories/:id
 *   /shared-memories, /shared-memories/{list,search,read,write,append,delete},
 *     /shared-memories/:slug
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
import { HostClaudeArtifactsService } from '../../services/host-claude-artifacts.js';
import { normalizeKind } from '../../services/claude-frontmatter.js';
import { McpMemoriesService } from '../../services/mcp-memories.js';
import { SharedMemoriesService } from '../../services/shared-memories.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, isEngine, type Engine } from '../../util/engine.js';
import { UnauthorizedError, ValidationError } from '../../http/errors.js';
import { assertHostEngineEnabled } from '../../services/host-engine-policy.js';

function extractEngine(input: unknown): Engine {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const e = (input as Record<string, unknown>)['engine'];
    if (isEngine(e)) return e as Engine;
  }
  return ENGINE_CODEX;
}

/**
 * Engine as provenance rather than routing: shared memories are engine-agnostic,
 * so an absent/unknown engine records null instead of defaulting to Codex.
 */
function extractEngineOrNull(input: unknown): Engine | null {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const e = (input as Record<string, unknown>)['engine'];
    if (isEngine(e)) return e as Engine;
  }
  return null;
}

function parseSlug(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

function requireHost(req: FastifyRequest) {
  if (!req.authHost) throw new UnauthorizedError('Invalid API key', 'invalid_api_key');
  return req.authHost;
}

function requireEngineHost(req: FastifyRequest, engine: Engine) {
  const host = requireHost(req);
  assertHostEngineEnabled(host, engine);
  return host;
}

export async function registerProjectsClientRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const projects = new HostProjectsService(ctx.db);
  const skills = new HostSkillsService(ctx.db);
  const agents = new HostAgentsService(ctx.db, {
    publicBaseUrl: ctx.env.PUBLIC_BASE_URL ?? null,
    keyring: ctx.keyring,
  });
  const memories = new McpMemoriesService(ctx.db);
  const sharedMemories = new SharedMemoriesService(ctx.db);
  const claudeArtifacts = new HostClaudeArtifactsService(ctx.db);
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
    const noteId = parseInteger(id);
    if (noteId === null || noteId <= 0) {
      throw new ValidationError('note id must be a positive integer', { param: 'id' });
    }
    return ok(await projects.upsertNote(parseSlug(slug), noteId, (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.delete('/projects/:slug/notes/:id', { preHandler: auth }, async (req) => {
    const { slug, id } = req.params as { slug: string; id: string };
    const noteId = parseInteger(id);
    if (noteId === null || noteId <= 0) {
      throw new ValidationError('note id must be a positive integer', { param: 'id' });
    }
    return ok(await projects.deleteNote(parseSlug(slug), noteId, requireHost(req)));
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
    const todoId = parseInteger(id);
    if (todoId === null || todoId <= 0) {
      throw new ValidationError('todo id must be a positive integer', { param: 'id' });
    }
    return ok(await projects.updateTodo(parseSlug(slug), todoId, (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.post('/projects/:slug/todos/:id/done', { preHandler: auth }, async (req) => {
    const { slug, id } = req.params as { slug: string; id: string };
    const todoId = parseInteger(id);
    if (todoId === null || todoId <= 0) {
      throw new ValidationError('todo id must be a positive integer', { param: 'id' });
    }
    return ok(await projects.setTodoDone(parseSlug(slug), todoId, true, requireHost(req)));
  });
  app.post('/projects/:slug/todos/:id/undone', { preHandler: auth }, async (req) => {
    const { slug, id } = req.params as { slug: string; id: string };
    const todoId = parseInteger(id);
    if (todoId === null || todoId <= 0) {
      throw new ValidationError('todo id must be a positive integer', { param: 'id' });
    }
    return ok(await projects.setTodoDone(parseSlug(slug), todoId, false, requireHost(req)));
  });
  app.delete('/projects/:slug/todos/:id', { preHandler: auth }, async (req) => {
    const { slug, id } = req.params as { slug: string; id: string };
    const todoId = parseInteger(id);
    if (todoId === null || todoId <= 0) {
      throw new ValidationError('todo id must be a positive integer', { param: 'id' });
    }
    return ok(await projects.deleteTodo(parseSlug(slug), todoId, requireHost(req)));
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
    const fileId = parseInteger(id);
    if (fileId === null || fileId <= 0) {
      throw new ValidationError('file id must be a positive integer', { param: 'id' });
    }
    return ok(await projects.deleteFile(parseSlug(slug), fileId, requireHost(req)));
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

  // Memories
  // No route collision: /memories/search is POST-only while /memories/:key is
  // GET/DELETE-only, so the static and param segments never compete on a verb.
  app.get('/projects/:slug/memories', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.listMemories(slug, (req.query as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.post('/projects/:slug/memories', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.upsertMemory(slug, (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.post('/projects/:slug/memories/search', { preHandler: auth }, async (req) => {
    const slug = parseSlug((req.params as { slug: string }).slug);
    return ok(await projects.searchMemories(slug, (req.body as Record<string, unknown>) ?? {}, requireHost(req)));
  });
  app.get('/projects/:slug/memories/:key', { preHandler: auth }, async (req) => {
    const { slug, key } = req.params as { slug: string; key: string };
    return ok(await projects.getMemory(parseSlug(slug), parseSlug(key), requireHost(req)));
  });
  app.delete('/projects/:slug/memories/:key', { preHandler: auth }, async (req) => {
    const { slug, key } = req.params as { slug: string; key: string };
    return ok(await projects.deleteMemory(parseSlug(slug), parseSlug(key), requireHost(req)));
  });

  // ─── Skills ───────────────────────────────────────────────────────────
  app.get('/skills', { preHandler: auth }, async (req) => {
    const engine = extractEngine(req.query);
    return ok(await skills.listSkills(requireEngineHost(req, engine), engine));
  });
  app.post('/skills/retrieve', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    const slug = String(payload['slug'] ?? payload['filename'] ?? '');
    const sha = typeof payload['sha256'] === 'string' ? (payload['sha256'] as string) : null;
    const engine = extractEngine(payload);
    return ok(await skills.retrieve(slug, sha, requireEngineHost(req, engine)));
  });
  app.post('/skills/store', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    const engine = extractEngine(payload);
    return ok(await skills.store(payload, requireEngineHost(req, engine)));
  });

  // ─── Agents + client config ───────────────────────────────────────────
  app.post('/agents/retrieve', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    const sha = typeof payload['sha256'] === 'string' ? (payload['sha256'] as string) : null;
    const engine = extractEngine(payload);
    const result = await agents.retrieve(sha, requireEngineHost(req, engine), engine);
    return ok({ ...result, engine });
  });
  app.post('/config/retrieve', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    const sha = typeof payload['sha256'] === 'string' ? (payload['sha256'] as string) : null;
    const engine = extractEngine(payload);
    const result = await agents.retrieveConfig(sha, requireEngineHost(req, engine), engine, {
      home: typeof payload['home'] === 'string' ? payload['home'] : null,
      username: typeof payload['username'] === 'string' ? payload['username'] : null,
    });
    return ok({ ...result, engine });
  });

  // ─── Claude artifacts (subagents / commands / output-styles) ──────────
  app.get('/claude/:kind', { preHandler: auth }, async (req) => {
    const kind = normalizeKind((req.params as { kind: string }).kind);
    const engine = extractEngine(req.query);
    return ok(await claudeArtifacts.list(kind, requireEngineHost(req, engine), engine));
  });
  app.post('/claude/:kind/retrieve', { preHandler: auth }, async (req) => {
    const kind = normalizeKind((req.params as { kind: string }).kind);
    const payload = (req.body as Record<string, unknown>) ?? {};
    const slug = String(payload['slug'] ?? payload['filename'] ?? '');
    const sha = typeof payload['sha256'] === 'string' ? (payload['sha256'] as string) : null;
    return ok(await claudeArtifacts.retrieve(kind, slug, sha, requireEngineHost(req, ENGINE_CLAUDE)));
  });
  // No host-originated store: Claude artifacts are admin-authored fleet-wide.
  // The host surface is read-only (list / retrieve / bundle).

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

  // ─── Shared memories (host-key, fleet-wide) ───────────────────────────
  // Deliberately not host-filtered: every host reads and writes the same
  // corpus. `engine` is provenance only and comes from the request body the
  // same way the other host routes take it.
  app.post('/shared-memories/list', { preHandler: auth }, async (req) =>
    ok(await sharedMemories.list((req.body as Record<string, unknown>) ?? {}, requireHost(req))),
  );
  app.get('/shared-memories', { preHandler: auth }, async (req) =>
    ok(await sharedMemories.list((req.query as Record<string, unknown>) ?? {}, requireHost(req))),
  );
  app.post('/shared-memories/search', { preHandler: auth }, async (req) =>
    ok(await sharedMemories.search((req.body as Record<string, unknown>) ?? {}, requireHost(req))),
  );
  app.post('/shared-memories/read', { preHandler: auth }, async (req) =>
    ok(await sharedMemories.read((req.body as Record<string, unknown>) ?? {}, requireHost(req))),
  );
  app.get<{ Params: { slug: string } }>('/shared-memories/:slug', { preHandler: auth }, async (req) =>
    ok(await sharedMemories.read({ ...((req.query as Record<string, unknown>) ?? {}), slug: parseSlug(req.params.slug) }, requireHost(req))),
  );
  app.post('/shared-memories/write', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    return ok(await sharedMemories.write(payload, requireHost(req), extractEngineOrNull(payload)));
  });
  app.post('/shared-memories/append', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    return ok(await sharedMemories.append(payload, requireHost(req), extractEngineOrNull(payload)));
  });
  app.post('/shared-memories/delete', { preHandler: auth }, async (req) => {
    const payload = (req.body as Record<string, unknown>) ?? {};
    return ok(await sharedMemories.delete(payload, requireHost(req), extractEngineOrNull(payload)));
  });
  app.delete<{ Params: { slug: string } }>('/shared-memories/:slug', { preHandler: auth }, async (req) =>
    ok(await sharedMemories.delete({ slug: parseSlug(req.params.slug) }, requireHost(req), null)),
  );
}

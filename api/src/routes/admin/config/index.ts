/**
 * Admin config / agents / skills / memories / mcp logs routes.
 *
 * Routes registered:
 *   GET    /admin/config
 *   GET    /admin/mcp/logs
 *   POST   /admin/config/render
 *   POST   /admin/config/store
 *   GET    /admin/agents
 *   GET    /admin/agents/versions/:id
 *   POST   /admin/agents/store
 *   POST   /admin/agents/serve
 *   POST   /admin/agents/revert
 *   POST   /admin/agents/retention
 *   DELETE /admin/agents/versions/:id
 *   GET    /admin/mcp/memories
 *   DELETE /admin/mcp/memories/:id
 *   GET    /admin/shared-memories
 *   GET    /admin/shared-memories/:slug
 *   DELETE /admin/shared-memories/:slug
 *   GET    /admin/skills
 *   GET    /admin/skills/:slug
 *   POST   /admin/skills/generate
 *   POST   /admin/skills/assist
 *   POST   /admin/skills/store
 *   DELETE /admin/skills/:slug
 *   GET    /admin/claude/:kind            (subagent|command|output-style)
 *   GET    /admin/claude/:kind/:slug
 *   POST   /admin/claude/:kind/store
 *   DELETE /admin/claude/:kind/:slug
 *
 * Every route is gated by `app.requireAdmin` from the auth-admin plugin.
 */
import type { FastifyInstance } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { hosts, mcpAccessLogs, versions } from '../../../db/schema.js';
import { NotFoundError, ValidationError } from '../../../http/errors.js';
import { ENGINE_CODEX, ENGINE_CLAUDE } from '../../../util/engine.js';
import type { RouteContext } from '../../index.js';
import { AgentsService } from '../../../services/agents.js';
import { ClientConfigService } from '../../../services/client-config.js';
import { MemoriesService } from '../../../services/memories.js';
import { SharedMemoriesService } from '../../../services/shared-memories.js';
import { SkillDraftsService } from '../../../services/skill-drafts.js';
import { SkillsService } from '../../../services/skills.js';
import { createRunnerClient } from '../../../services/runner-client.js';
import { createRunnerValidationService } from '../../../services/runner-validation.js';
import { ClaudeArtifactsService } from '../../../services/claude-artifacts.js';
import { normalizeKind } from '../../../services/claude-frontmatter.js';
import { nowIso } from '../../../util/timestamp.js';

const AGENTS_BACKUP_LIMIT_KEY = 'agents_backup_limit';

function parseInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === 0 || value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return null;
}

export async function registerAdminConfigRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const db = ctx.db;
  const clientConfig = new ClientConfigService(db);
  const skills = new SkillsService(db);
  const claudeArtifacts = new ClaudeArtifactsService(db);
  // AI-assisted skill drafting. Wire the runner only when configured
  // (AUTH_RUNNER_URL set); otherwise the service returns the actionable
  // `runner_unavailable` prompt for /admin/skills/{generate,assist}.
  const skillRunner = createRunnerClient({ env: ctx.env });
  const skillDrafts = new SkillDraftsService(
    skillRunner.isConfigured()
      ? {
          db,
          runner: skillRunner,
          runnerValidation: createRunnerValidationService({ db, keyring: ctx.keyring }),
        }
      : { db },
  );
  const memories = new MemoriesService(db);
  const sharedMemories = new SharedMemoriesService(db);
  const agents = new AgentsService(db, async () => {
    const rows = await db.select().from(versions).where(sql`name = ${AGENTS_BACKUP_LIMIT_KEY}`).limit(1);
    const v = rows[0]?.version;
    if (typeof v !== 'string' || v.trim() === '' || !/^\d+$/.test(v.trim())) return null;
    const n = parseInt(v.trim(), 10);
    return n > 0 ? Math.min(n, 200) : null;
  });

  // ── /admin/config ────────────────────────────────────────────────────────

  app.get('/admin/config', { preHandler: app.requireAdmin }, async () => {
    return await clientConfig.adminFetch();
  });

  app.post<{ Body: { settings?: unknown } }>(
    '/admin/config/render',
    { preHandler: app.requireAdmin },
    async (req) => {
      const settings = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).settings : null;
      return clientConfig.render(settings);
    },
  );

  app.post<{ Body: { settings?: unknown; sha256?: unknown } }>(
    '/admin/config/store',
    { preHandler: app.requireAdmin },
    async (req) => {
      const body = (req.body && typeof req.body === 'object') ? req.body as { settings?: unknown; sha256?: unknown } : {};
      return await clientConfig.store(body, null);
    },
  );

  // ── /admin/mcp/logs ──────────────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string } }>(
    '/admin/mcp/logs',
    { preHandler: app.requireAdmin },
    async (req) => {
      const limit = Math.max(1, Math.min(parseInteger(req.query.limit) ?? 200, 500));
      // Left join so rows whose host has been pruned (or that were never bound
      // to one) still list, with a null Host column instead of dropping out.
      const rows = await db
        .select({
          id: mcpAccessLogs.id,
          hostId: mcpAccessLogs.hostId,
          host_fqdn: hosts.fqdn,
          clientIp: mcpAccessLogs.clientIp,
          method: mcpAccessLogs.method,
          name: mcpAccessLogs.name,
          success: mcpAccessLogs.success,
          errorCode: mcpAccessLogs.errorCode,
          errorMessage: mcpAccessLogs.errorMessage,
          createdAt: mcpAccessLogs.createdAt,
          engine: mcpAccessLogs.engine,
        })
        .from(mcpAccessLogs)
        .leftJoin(hosts, eq(hosts.id, mcpAccessLogs.hostId))
        .orderBy(desc(mcpAccessLogs.createdAt))
        .limit(limit);
      return { logs: rows };
    },
  );

  // ── /admin/agents ────────────────────────────────────────────────────────

  app.get('/admin/agents', { preHandler: app.requireAdmin }, async () => {
    return await agents.adminFetch(ENGINE_CODEX);
  });

  app.get<{ Params: { id: string } }>(
    '/admin/agents/versions/:id',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = parseInteger(req.params.id);
      if (id === null || id <= 0) {
        throw new ValidationError('version_id must be a positive integer', { param: 'id' });
      }
      return await agents.adminFetchVersion(id);
    },
  );

  app.post<{ Body: { content?: unknown; body?: unknown; sha256?: unknown; engine?: unknown } }>(
    '/admin/agents/store',
    { preHandler: app.requireAdmin },
    async (req) => {
      const payload = req.body && typeof req.body === 'object' ? req.body : {};
      const content = typeof payload.content === 'string' ? payload.content : typeof payload.body === 'string' ? payload.body : '';
      return await agents.store(content, payload.sha256 ?? null, null, payload.engine ?? ENGINE_CODEX);
    },
  );

  app.post<{ Body: { mode?: unknown; version_id?: unknown; engine?: unknown } }>(
    '/admin/agents/serve',
    { preHandler: app.requireAdmin },
    async (req) => {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const versionId = parseInteger(body.version_id);
      return await agents.setServeMode(body.mode ?? '', versionId, body.engine ?? ENGINE_CODEX);
    },
  );

  app.post<{ Body: { version_id?: unknown; engine?: unknown } }>(
    '/admin/agents/revert',
    { preHandler: app.requireAdmin },
    async (req) => {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const versionId = parseInteger(body.version_id) ?? 0;
      return await agents.revertVersion(versionId, body.engine ?? ENGINE_CODEX);
    },
  );

  app.post<{ Body: { backup_limit?: unknown } }>(
    '/admin/agents/retention',
    { preHandler: app.requireAdmin },
    async (req) => {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      return await agents.updateBackupRetention(body.backup_limit ?? null, async (value) => {
        const nowTs = nowIso();
        const existing = await db.select().from(versions).where(sql`name = ${AGENTS_BACKUP_LIMIT_KEY}`).limit(1);
        if (value === null) {
          if (existing[0]) {
            await db.delete(versions).where(sql`name = ${AGENTS_BACKUP_LIMIT_KEY}`);
          }
        } else if (existing[0]) {
          await db.update(versions).set({ version: String(value), updatedAt: nowTs }).where(sql`name = ${AGENTS_BACKUP_LIMIT_KEY}`);
        } else {
          await db.insert(versions).values({ name: AGENTS_BACKUP_LIMIT_KEY, version: String(value), updatedAt: nowTs });
        }
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/agents/versions/:id',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = parseInteger(req.params.id);
      if (id === null || id <= 0) {
        throw new ValidationError('version_id must be a positive integer', { param: 'id' });
      }
      return await agents.deleteVersion(id);
    },
  );

  // ── /admin/mcp/memories ──────────────────────────────────────────────────

  app.get<{ Querystring: { q?: string; query?: string; host_id?: string; tags?: string; limit?: string } }>(
    '/admin/mcp/memories',
    { preHandler: app.requireAdmin },
    async (req) => {
      const q = req.query.q ?? req.query.query ?? '';
      const limit = parseInteger(req.query.limit) ?? 50;
      return await memories.adminSearch({
        query: q,
        limit,
        host_id: req.query.host_id ?? null,
        tags: req.query.tags ?? '',
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/mcp/memories/:id',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = parseInteger(req.params.id);
      if (id === null || id <= 0) {
        throw new ValidationError('id must be a positive integer', { param: 'id' });
      }
      return await memories.adminDelete(id);
    },
  );

  // ── /admin/shared-memories ───────────────────────────────────────────────
  // Fleet-wide corpus: no host_id filter exists here because the rows are not
  // host-scoped. `q` switches from a recency listing to a relevance search.

  app.get<{ Querystring: { q?: string; query?: string; tags?: string; prefix?: string; limit?: string; offset?: string } }>(
    '/admin/shared-memories',
    { preHandler: app.requireAdmin },
    async (req) =>
      await sharedMemories.adminList({
        query: req.query.q ?? req.query.query ?? '',
        tags: req.query.tags ?? '',
        prefix: req.query.prefix ?? '',
        limit: parseInteger(req.query.limit) ?? 50,
        offset: parseInteger(req.query.offset) ?? 0,
      }),
  );

  app.get<{ Params: { slug: string } }>(
    '/admin/shared-memories/:slug',
    { preHandler: app.requireAdmin },
    async (req) => await sharedMemories.adminDetail(decodeURIComponent(req.params.slug)),
  );

  app.delete<{ Params: { slug: string } }>(
    '/admin/shared-memories/:slug',
    { preHandler: app.requireAdmin },
    async (req) => await sharedMemories.adminDelete(decodeURIComponent(req.params.slug)),
  );

  // ── /admin/skills ────────────────────────────────────────────────────────

  app.get('/admin/skills', { preHandler: app.requireAdmin }, async () => {
    const list = await skills.list({ includeDeleted: true });
    return { skills: list };
  });

  app.get<{ Params: { slug: string } }>(
    '/admin/skills/:slug',
    { preHandler: app.requireAdmin },
    async (req) => {
      const found = await skills.find(decodeURIComponent(req.params.slug));
      if (!found) {
        throw new NotFoundError('Skill not found', 'skill_not_found');
      }
      return found;
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/admin/skills/generate',
    { preHandler: app.requireAdmin },
    async (req) => {
      return skillDrafts.generate(req.body ?? {});
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/admin/skills/assist',
    { preHandler: app.requireAdmin },
    async (req) => {
      return skillDrafts.assist(req.body ?? {});
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/admin/skills/store',
    { preHandler: app.requireAdmin },
    async (req) => {
      const payload = (req.body && typeof req.body === 'object') ? req.body : {};
      return await skills.store(payload, null);
    },
  );

  app.delete<{ Params: { slug: string } }>(
    '/admin/skills/:slug',
    { preHandler: app.requireAdmin },
    async (req) => {
      const slug = decodeURIComponent(req.params.slug);
      const deleted = await skills.softDelete(slug);
      if (!deleted) {
        throw new NotFoundError('Skill not found', 'skill_not_found');
      }
      return { deleted: slug };
    },
  );

  // ── /admin/claude/config (engine=claude settings.json sub-blocks) ─────────

  app.get('/admin/claude/config', { preHandler: app.requireAdmin }, async () => {
    return await clientConfig.adminFetch(ENGINE_CLAUDE);
  });

  app.post<{ Body: { settings?: unknown } }>(
    '/admin/claude/config/render',
    { preHandler: app.requireAdmin },
    async (req) => {
      const settings = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).settings : null;
      return clientConfig.render(settings, ENGINE_CLAUDE);
    },
  );

  app.post<{ Body: { settings?: unknown; sha256?: unknown } }>(
    '/admin/claude/config/store',
    { preHandler: app.requireAdmin },
    async (req) => {
      const body = req.body && typeof req.body === 'object' ? (req.body as { settings?: unknown; sha256?: unknown }) : {};
      return await clientConfig.store(body, null, ENGINE_CLAUDE);
    },
  );

  // ── /admin/claude/:kind (subagents | commands | output-styles) ────────────

  app.get<{ Params: { kind: string } }>(
    '/admin/claude/:kind',
    { preHandler: app.requireAdmin },
    async (req) => {
      const kind = normalizeKind(req.params.kind);
      const list = await claudeArtifacts.list(kind, { includeDeleted: true });
      return { kind, artifacts: list };
    },
  );

  app.get<{ Params: { kind: string; slug: string } }>(
    '/admin/claude/:kind/:slug',
    { preHandler: app.requireAdmin },
    async (req) => {
      const kind = normalizeKind(req.params.kind);
      const found = await claudeArtifacts.find(kind, decodeURIComponent(req.params.slug));
      if (!found) throw new NotFoundError('artifact not found', 'artifact_not_found');
      return found;
    },
  );

  app.post<{ Params: { kind: string }; Body: Record<string, unknown> }>(
    '/admin/claude/:kind/store',
    { preHandler: app.requireAdmin },
    async (req) => {
      const kind = normalizeKind(req.params.kind);
      const payload = req.body && typeof req.body === 'object' ? req.body : {};
      return await claudeArtifacts.store(kind, payload, null);
    },
  );

  app.delete<{ Params: { kind: string; slug: string } }>(
    '/admin/claude/:kind/:slug',
    { preHandler: app.requireAdmin },
    async (req) => {
      const kind = normalizeKind(req.params.kind);
      const slug = decodeURIComponent(req.params.slug);
      const deleted = await claudeArtifacts.softDelete(kind, slug);
      if (!deleted) throw new NotFoundError('artifact not found', 'artifact_not_found');
      return { deleted: slug, kind };
    },
  );

  // suppress lint unused
  void parseBoolean;
}

import { ProviderAccountsService } from '../../../services/provider-accounts.js';
/**
 * Admin projects routes. Owns the full project tree:
 *
 *   GET    /admin/projects/state
 *   POST   /admin/projects/state
 *   GET    /admin/projects/feedback
 *   GET    /admin/projects
 *   POST   /admin/projects
 *   DELETE /admin/projects/:slug
 *   GET    /admin/projects/:slug
 *   POST   /admin/projects/:slug/assist
 *   POST   /admin/projects/:slug/about
 *   POST   /admin/projects/:slug/roster
 *   GET    /admin/projects/:slug/changes
 *   GET    /admin/projects/:slug/slop-jobs
 *   GET    /admin/projects/:slug/slop-jobs/:id
 *   GET    /admin/slop-jobs/state
 *   POST   /admin/slop-jobs/state
 *   GET    /admin/projects/:slug/notes
 *   POST   /admin/projects/:slug/notes
 *   POST   /admin/projects/:slug/notes/:id
 *   DELETE /admin/projects/:slug/notes/:id
 *   GET    /admin/projects/:slug/todos
 *   POST   /admin/projects/:slug/todos
 *   POST   /admin/projects/:slug/todos/:id
 *   POST   /admin/projects/:slug/todos/:id/done
 *   POST   /admin/projects/:slug/todos/:id/undone
 *   DELETE /admin/projects/:slug/todos/:id
 *   GET    /admin/projects/:slug/files
 *   POST   /admin/projects/:slug/files
 *   DELETE /admin/projects/:slug/files/:id
 *   GET    /admin/projects/:slug/feedback
 *   POST   /admin/projects/:slug/feedback
 */
import type { FastifyInstance } from 'fastify';
import { ValidationError } from '../../../http/errors.js';
import { AdminEventsService } from '../../../services/admin-events.js';
import type { RouteContext } from '../../index.js';
import { slopJobsService } from '../../../services/slop-jobs.js';
import { ProjectContentService } from '../../../services/project-content.js';
import { ProjectDraftsService } from '../../../services/project-drafts.js';
import { ProjectsService } from '../../../services/projects.js';
import { createRunnerClient } from '../../../services/runner-client.js';
import { createRunnerValidationService } from '../../../services/runner-validation.js';
import { adminSpaHtmlPreHandler } from '../pages/static.js';

function parseInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

/** The `parseInteger` + positivity check every `:id` route repeats. */
function positiveId(value: unknown, label: string): number {
  const id = parseInteger(value);
  if (id === null || id <= 0) {
    throw new ValidationError(`${label} must be a positive integer`, { param: 'id' });
  }
  return id;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function registerAdminProjectsRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const adminSpa = adminSpaHtmlPreHandler(ctx);
  const projects = new ProjectsService(ctx.db);
  const content = new ProjectContentService(ctx.db, projects);
  // AI-assisted draft helper. Wire the runner integration only when it is
  // actually configured (AUTH_RUNNER_URL set); otherwise leave the runner deps
  // off so /assist returns the actionable `runner_unavailable` prompt.
  const draftRunner = createRunnerClient({ env: ctx.env });
  const drafts = new ProjectDraftsService(
    draftRunner.isConfigured()
      ? {
          db: ctx.db,
          projects,
          runner: draftRunner,
          accounts: new ProviderAccountsService(ctx.db, ctx.keyring),
          runnerValidation: createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring }),
        }
      : { db: ctx.db, projects },
  );

  // ── module state ─────────────────────────────────────────────────────────

  app.get('/admin/projects/state', { preHandler: app.requireAdmin }, async () => {
    return await projects.adminState();
  });

  app.post<{ Body: { enabled?: unknown } }>(
    '/admin/projects/state',
    { preHandler: app.requireAdmin },
    async (req) => {
      const body = asRecord(req.body);
      const flagValue = body.enabled;
      let enabled: boolean | null = null;
      if (typeof flagValue === 'boolean') enabled = flagValue;
      else if (flagValue === 1 || flagValue === '1' || flagValue === 'true') enabled = true;
      else if (flagValue === 0 || flagValue === '0' || flagValue === 'false') enabled = false;
      if (enabled === null) {
        throw new ValidationError('enabled must be true or false', { param: 'enabled' });
      }
      return await projects.setEnabled(enabled);
    },
  );

  // ── cross-project feedback (must come before /:slug) ─────────────────────

  app.get('/admin/projects/feedback', { preHandler: [adminSpa, app.requireAdmin] }, async () => {
    return await content.listFeedback(null);
  });

  // ── projects index / create ──────────────────────────────────────────────

  app.get('/admin/projects', { preHandler: [adminSpa, app.requireAdmin] }, async () => {
    return await projects.list();
  });

  app.post<{ Body: Record<string, unknown> }>(
    '/admin/projects',
    { preHandler: app.requireAdmin },
    async (req) => {
      return await projects.create(asRecord(req.body), null);
    },
  );

  // ── single project ───────────────────────────────────────────────────────

  app.get<{ Params: { slug: string } }>(
    '/admin/projects/:slug',
    { preHandler: [adminSpa, app.requireAdmin] },
    async (req) => {
      return await projects.detail(decodeURIComponent(req.params.slug));
    },
  );

  app.delete<{ Params: { slug: string } }>(
    '/admin/projects/:slug',
    { preHandler: app.requireAdmin },
    async (req) => {
      return await projects.deleteBySlug(decodeURIComponent(req.params.slug), null);
    },
  );

  app.post<{ Params: { slug: string } }>(
    '/admin/projects/:slug/assist',
    { preHandler: app.requireAdmin },
    async (req) => {
      return drafts.assist(decodeURIComponent(req.params.slug));
    },
  );

  app.get<{ Params: { slug: string } }>(
    '/admin/projects/:slug/summary',
    { preHandler: app.requireAdmin },
    async (req) => projects.summary(decodeURIComponent(req.params.slug)),
  );

  app.post<{ Params: { slug: string } }>(
    '/admin/projects/:slug/archive',
    { preHandler: app.requireAdmin },
    async (req) => projects.setArchived(decodeURIComponent(req.params.slug), true, null),
  );

  app.post<{ Params: { slug: string } }>(
    '/admin/projects/:slug/unarchive',
    { preHandler: app.requireAdmin },
    async (req) => projects.setArchived(decodeURIComponent(req.params.slug), false, null),
  );

  app.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    '/admin/projects/:slug/about',
    { preHandler: app.requireAdmin },
    async (req) => {
      return await projects.updateAbout(decodeURIComponent(req.params.slug), asRecord(req.body), null);
    },
  );

  app.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    '/admin/projects/:slug/roster',
    { preHandler: app.requireAdmin },
    async (req) => {
      return await projects.updateRoster(decodeURIComponent(req.params.slug), asRecord(req.body), null);
    },
  );

  app.get<{ Params: { slug: string }; Querystring: { since?: string } }>(
    '/admin/projects/:slug/changes',
    { preHandler: app.requireAdmin },
    async (req) => {
      const since = parseInteger(req.query.since) ?? 0;
      return await projects.listChanges(decodeURIComponent(req.params.slug), Math.max(0, since));
    },
  );

  // ── slop jobs (read-only; agents own them through MCP) ──────────────────

  const slop = slopJobsService(ctx);
  app.get<{ Params: { slug: string } }>(
    '/admin/projects/:slug/slop-jobs',
    { preHandler: app.requireAdmin },
    async (req) => slop.adminList(decodeURIComponent(req.params.slug)),
  );
  app.get<{ Params: { slug: string; id: string } }>(
    '/admin/projects/:slug/slop-jobs/:id',
    { preHandler: app.requireAdmin },
    async (req) => slop.adminGet(decodeURIComponent(req.params.slug), req.params.id),
  );
  // Fleet switch, beside the project-board one; default on.
  app.get('/admin/slop-jobs/state', { preHandler: app.requireAdmin }, async () => slop.adminState());
  app.post('/admin/slop-jobs/state', { preHandler: app.requireAdmin }, async (req) => {
    const raw = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (![true, false, 0, 1, '0', '1', 'true', 'false'].includes(raw as never))
      throw new ValidationError('enabled must be a boolean', { param: 'enabled' });
    const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
    const state = await slop.setEnabled(enabled);
    await new AdminEventsService(ctx.db).record({
      type: 'slop_jobs.module_toggled',
      payload: { enabled, admin_user_id: req.admin?.user?.id ?? null },
    });
    return state;
  });

  // ── notes ────────────────────────────────────────────────────────────────

  app.get<{ Params: { slug: string } }>(
    '/admin/projects/:slug/notes',
    { preHandler: [adminSpa, app.requireAdmin] },
    async (req) => content.listNotes(decodeURIComponent(req.params.slug)),
  );

  app.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    '/admin/projects/:slug/notes',
    { preHandler: app.requireAdmin },
    async (req) => content.upsertNote(decodeURIComponent(req.params.slug), null, asRecord(req.body), null),
  );

  app.post<{ Params: { slug: string; id: string }; Body: Record<string, unknown> }>(
    '/admin/projects/:slug/notes/:id',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = parseInteger(req.params.id);
      if (id === null || id <= 0) {
        throw new ValidationError('note id must be a positive integer', { param: 'id' });
      }
      return content.upsertNote(decodeURIComponent(req.params.slug), id, asRecord(req.body), null);
    },
  );

  app.delete<{ Params: { slug: string; id: string } }>(
    '/admin/projects/:slug/notes/:id',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = parseInteger(req.params.id);
      if (id === null || id <= 0) {
        throw new ValidationError('note id must be a positive integer', { param: 'id' });
      }
      return content.deleteNote(decodeURIComponent(req.params.slug), id, null);
    },
  );

  // ── todos ────────────────────────────────────────────────────────────────

  app.get<{ Params: { slug: string } }>(
    '/admin/projects/:slug/todos',
    { preHandler: [adminSpa, app.requireAdmin] },
    async (req) => content.listTodos(decodeURIComponent(req.params.slug)),
  );

  app.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    '/admin/projects/:slug/todos',
    { preHandler: app.requireAdmin },
    async (req) => content.createTodo(decodeURIComponent(req.params.slug), asRecord(req.body), null),
  );

  app.post<{ Params: { slug: string; id: string }; Body: Record<string, unknown> }>(
    '/admin/projects/:slug/todos/:id',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = parseInteger(req.params.id);
      if (id === null || id <= 0) {
        throw new ValidationError('todo id must be a positive integer', { param: 'id' });
      }
      return content.updateTodo(decodeURIComponent(req.params.slug), id, asRecord(req.body), null);
    },
  );

  app.post<{ Params: { slug: string; id: string } }>(
    '/admin/projects/:slug/todos/:id/done',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = parseInteger(req.params.id);
      if (id === null || id <= 0) {
        throw new ValidationError('todo id must be a positive integer', { param: 'id' });
      }
      return content.setTodoDone(decodeURIComponent(req.params.slug), id, true, null);
    },
  );

  app.post<{ Params: { slug: string; id: string } }>(
    '/admin/projects/:slug/todos/:id/undone',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = parseInteger(req.params.id);
      if (id === null || id <= 0) {
        throw new ValidationError('todo id must be a positive integer', { param: 'id' });
      }
      return content.setTodoDone(decodeURIComponent(req.params.slug), id, false, null);
    },
  );

  app.delete<{ Params: { slug: string; id: string } }>(
    '/admin/projects/:slug/todos/:id',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = parseInteger(req.params.id);
      if (id === null || id <= 0) {
        throw new ValidationError('todo id must be a positive integer', { param: 'id' });
      }
      return content.deleteTodo(decodeURIComponent(req.params.slug), id, null);
    },
  );

  // ── files ────────────────────────────────────────────────────────────────

  app.get<{ Params: { slug: string } }>(
    '/admin/projects/:slug/files',
    { preHandler: [adminSpa, app.requireAdmin] },
    async (req) => content.listFiles(decodeURIComponent(req.params.slug)),
  );

  app.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    '/admin/projects/:slug/files',
    { preHandler: app.requireAdmin },
    async (req) => content.upsertFile(decodeURIComponent(req.params.slug), asRecord(req.body), null),
  );

  app.get<{ Params: { slug: string; id: string } }>(
    '/admin/projects/:slug/files/:id',
    { preHandler: app.requireAdmin },
    async (req) =>
      content.readFile(decodeURIComponent(req.params.slug), positiveId(req.params.id, 'file id')),
  );

  app.delete<{ Params: { slug: string; id: string } }>(
    '/admin/projects/:slug/files/:id',
    { preHandler: app.requireAdmin },
    async (req) => {
      const id = parseInteger(req.params.id);
      if (id === null || id <= 0) {
        throw new ValidationError('file id must be a positive integer', { param: 'id' });
      }
      return content.deleteFile(decodeURIComponent(req.params.slug), id, null);
    },
  );

  // ── feedback ─────────────────────────────────────────────────────────────

  app.get<{ Params: { slug: string } }>(
    '/admin/projects/:slug/feedback',
    { preHandler: [adminSpa, app.requireAdmin] },
    async (req) => content.listFeedback(decodeURIComponent(req.params.slug)),
  );

  app.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    '/admin/projects/:slug/feedback',
    { preHandler: app.requireAdmin },
    async (req) => content.createFeedback(decodeURIComponent(req.params.slug), asRecord(req.body), null),
  );

  app.post<{ Params: { slug: string; id: string }; Body: Record<string, unknown> }>(
    '/admin/projects/:slug/feedback/:id',
    { preHandler: app.requireAdmin },
    async (req) =>
      content.updateFeedback(
        decodeURIComponent(req.params.slug),
        positiveId(req.params.id, 'feedback id'),
        asRecord(req.body),
        null,
      ),
  );
}

import { desc, eq } from 'drizzle-orm';
import type { RouteContext } from '../../routes/index.js';
import type { CompanionToolsDeps } from '../../routes/companion/tools.js';
import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { agentScheduleRuns, hostDaemonSessions } from '../../db/schema.js';
import { ForbiddenError } from '../../http/errors.js';
import { wsPublisher } from '../../ws/publisher.js';
import type { CompanionDevices } from './devices.js';
import type { HostDaemonService } from '../host-daemon/service.js';
import { createAgentMessagingService } from '../agent-messaging.js';
import { createWorkflowsService } from '../../routes/agent-messaging/workflows.js';
import { SchedulesService } from '../schedules.js';
import { GitDirectorService } from '../git-director.js';
import { GitDirectorNotifications } from '../git-director/notifications.js';
import { SettingsService } from '../settings.js';
import { ProjectsService } from '../projects.js';
import { ProjectBoardService } from '../project-board.js';
import { HostProjectsService } from '../host-projects.js';
import { FeedbackService } from '../feedback.js';

type Run = Pick<typeof agentScheduleRuns.$inferSelect, 'scheduleId' | 'status' | 'dueAt' | 'lastError' | 'updatedAt' | 'createdAt'>;
const runView = (run: Run) => ({ status: run.status, due_at: run.dueAt, last_error: run.lastError ?? null, updated_at: run.updatedAt });

/** Production wiring for the R4 companion tools; the same services the admin routes use. */
export function companionToolsDeps(ctx: RouteContext, devices: CompanionDevices, daemon: HostDaemonService): CompanionToolsDeps {
  const messaging = createAgentMessagingService(ctx.db, ctx.env, ctx.keyring);
  const workflows = createWorkflowsService(ctx, messaging);
  const schedules = new SchedulesService(ctx.db, ctx.keyring);
  const settings = new SettingsService(ctx.db);
  const director = new GitDirectorService({
    notifications: new GitDirectorNotifications(messaging, ctx.env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS),
    db: ctx.db,
    settings,
    freshSeconds: ctx.env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS,
    cloneArchiveDays: ctx.env.GIT_DIRECTOR_CLONE_ARCHIVE_DAYS,
  });
  const projects = new ProjectsService(ctx.db);
  const board = new ProjectBoardService({
    db: ctx.db,
    projects: new HostProjectsService(ctx.db),
    settings,
    freshSeconds: ctx.env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS,
  });
  const feedback = new FeedbackService(ctx.db, ctx.keyring);
  return {
    authorize: (req, capability) => devices.authenticate(req.headers.authorization, capability),
    daemon,
    async ownSession(id, userId) {
      const owner = ownerRuntimeFor(ctx.db);
      owner?.assertOwner();
      const row = owner
        ? owner.state.snapshot().table('hostDaemonSessions').get(id)
        : (await ctx.db.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.id, id)))[0];
      if (!row) return null;
      if (row.owner !== `admin:${userId}`)
        throw new ForbiddenError('This remote conversation belongs to another operator');
      return { id: row.id, status: row.status };
    },
    workflowRuns: (query) => workflows.runList(query),
    schedules: {
      list: () => schedules.list({ limit: 200 }),
      async lastRuns(ids) {
        const out = new Map<string, Record<string, unknown>>();
        const owner = ownerRuntimeFor(ctx.db);
        if (owner) {
          owner.assertOwner();
          const table = owner.state.snapshot().table('agentScheduleRuns');
          for (const id of ids) {
            const latest = [...table.by('scheduleId', id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            if (latest) out.set(id, runView(latest));
          }
          return out;
        }
        await Promise.all(
          ids.map(async (id) => {
            const [latest] = await ctx.db
              .select()
              .from(agentScheduleRuns)
              .where(eq(agentScheduleRuns.scheduleId, id))
              .orderBy(desc(agentScheduleRuns.createdAt))
              .limit(1);
            if (latest) out.set(id, runView(latest));
          }),
        );
        return out;
      },
      get: (id) => schedules.get(id),
      update: (raw, actor) => schedules.update(raw, actor),
    },
    gitDirector: { state: () => director.adminState(), clones: () => director.adminClones() },
    projects: {
      list: async () => (await projects.list()) as unknown as { projects: Array<Record<string, unknown>> },
      boardState: () => board.adminState(),
      board: (slug) => board.adminBoard(slug),
    },
    feedback: { submit: (input, actor) => feedback.submit(input, actor) as unknown as Promise<Record<string, unknown>> },
    changed: () => wsPublisher.publish('companion.devices.changed', {}),
  };
}

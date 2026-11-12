import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ConflictError, NotFoundError } from '../../../http/errors.js';
import { SettingsService } from '../../../services/settings.js';
import { appendAuditLog } from '../../../services/audit-log.js';
import { nowIso } from '../../../util/timestamp.js';
import {
  RolloutConflictError,
  completeRollout,
  haltRollout,
  readRolloutEnabled,
  WRAPPER_ROLLOUT_ENABLED_KEY,
  promoteRollout,
  resumeRollout,
  rolloutSettingsFromEnv,
  rolloutStatus,
  setHostWrapperCanary,
} from '../../../services/wrapper-rollout.js';

/**
 * Operator controls for the staged cxx rollout (services/wrapper-rollout.ts).
 * Halting freezes the waves; it never moves a host back.
 */

const actionSchema = z.object({ action: z.enum(['halt', 'resume', 'promote', 'complete']) });
const actionBodySchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();
const canarySchema = z.object({ enabled: z.boolean() }).strict();

export async function registerAdminWrapperRolloutRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const envSettings = rolloutSettingsFromEnv(ctx.env);
  const settingsService = new SettingsService(ctx.db);
  // The operator switch is read per request: a toggle applies at once, no restart.
  const effective = async () => {
    const switchState = await readRolloutEnabled(ctx.db, ctx.env);
    return { settings: { ...envSettings, enabled: switchState.enabled }, source: switchState.source };
  };
  const actorOf = (req: { admin?: { user: { username?: string | null; name?: string | null; id: number } } }) => {
    const user = req.admin!.user;
    return user.username || user.name || `admin:${user.id}`;
  };

  app.get('/admin/wrapper/rollout', { preHandler: app.requireAdmin }, async () => {
    const { settings, source } = await effective();
    return rolloutStatus(ctx.db, settings, source);
  });

  app.get('/admin/wrapper/rollout/enabled', { preHandler: app.requireAdmin }, async () => {
    const { settings, source } = await effective();
    return { enabled: settings.enabled, source };
  });

  app.post('/admin/wrapper/rollout/enabled', { preHandler: app.requireAdmin }, async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body ?? {});
    await settingsService.setFlag(WRAPPER_ROLLOUT_ENABLED_KEY, enabled);
    await appendAuditLog(ctx.db, {
      hostId: null,
      action: 'admin.wrapper_rollout_enabled',
      details: JSON.stringify({ enabled, by: actorOf(req) }),
      createdAt: nowIso(),
    });
    const { settings, source } = await effective();
    return { enabled: settings.enabled, source };
  });

  app.post('/admin/wrapper/rollout/:action', { preHandler: app.requireAdmin }, async (req) => {
    const { action } = actionSchema.parse(req.params);
    const body = actionBodySchema.parse(req.body ?? {});
    const actor = actorOf(req);
    try {
      if (action === 'halt') await haltRollout(ctx.db, actor, body.reason);
      else if (action === 'resume') await resumeRollout(ctx.db, actor);
      else if (action === 'promote') await promoteRollout(ctx.db, actor);
      else await completeRollout(ctx.db, actor);
    } catch (err) {
      if (err instanceof RolloutConflictError) throw new ConflictError(err.message);
      throw err;
    }
    const { settings, source } = await effective();
    return rolloutStatus(ctx.db, settings, source);
  });

  app.post('/admin/hosts/:id/wrapper-canary', { preHandler: app.requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { enabled } = canarySchema.parse(req.body ?? {});
    if (!(await setHostWrapperCanary(ctx.db, id, enabled, actorOf(req)))) throw new NotFoundError('host not found');
    return { id, wrapper_canary: enabled };
  });
}

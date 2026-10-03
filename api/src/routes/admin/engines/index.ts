/**
 * /admin/engines/* — fleet-wide engine master switches.
 *
 *   GET  /admin/engines/state            one row per engine
 *   POST /admin/engines/:engine/state    { enabled: boolean }
 *
 * The switch semantics live in `services/engine-switch.ts`; this module only
 * validates input and names the actor for the audit row.
 */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { ValidationError } from '../../../http/errors.js';
import { ok } from '../../../http/reply.js';
import { isEngine } from '../../../util/engine.js';
import { listEngineStates, setFleetEngineEnabled } from '../../../services/engine-switch.js';

export async function registerAdminEngineRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get('/admin/engines/state', { preHandler: app.requireAdmin }, async () => {
    return ok({ engines: await listEngineStates(ctx.db) });
  });

  app.post('/admin/engines/:engine/state', { preHandler: app.requireAdmin }, async (req) => {
    const { engine } = req.params as { engine?: string };
    const normalized = typeof engine === 'string' ? engine.trim().toLowerCase() : '';
    if (!isEngine(normalized)) {
      throw new ValidationError('engine must be "codex", "claude" or "grok"', { param: 'engine' });
    }
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      throw new ValidationError('enabled must be boolean', { param: 'enabled' });
    }
    const actor = req.admin?.user.username ?? null;
    const change = await setFleetEngineEnabled(ctx.db, normalized, body.enabled, actor);
    const row = (await listEngineStates(ctx.db)).find((r) => r.engine === normalized);
    return ok({ ...row, previous: change.previous, hosts_suspended: change.hosts_suspended });
  });
}

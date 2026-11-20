/**
 * /admin/engines/* — fleet-wide engine master switches.
 *
 *   GET  /admin/engines/active           {engine,label,enabled} per engine (admin.read)
 *   GET  /admin/engines/state            one row per engine
 *   POST /admin/engines/:engine/state    { enabled: boolean }
 *   GET    /admin/engines/:engine/destroy        progress of a destroy request
 *   POST   /admin/engines/:engine/destroy        { confirm: "<engine>" } open one
 *   POST   /admin/engines/:engine/destroy/purge  { force?: boolean } drop server data
 *   DELETE /admin/engines/:engine/destroy        cancel the request
 *
 * The switch semantics live in `services/engine-switch.ts`; this module only
 * validates input and names the actor for the audit row.
 */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { ValidationError } from '../../../http/errors.js';
import { ok } from '../../../http/reply.js';
import { ENGINE_LABELS, ENGINES, isEngine } from '../../../util/engine.js';
import { listEngineStates, readFleetEngineState, setFleetEngineEnabled } from '../../../services/engine-switch.js';
import {
  assertNoDestroyRequest,
  cancelEngineDestroy,
  listDestroyProgress,
  purgeEngineServerData,
  requestEngineDestroy,
} from '../../../services/engine-destroy.js';

export async function registerAdminEngineRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  // The console's single source for "which engines belong to the fleet". Every
  // signed-in viewer needs it to hide switched-off engines, so it carries no
  // actor, timestamp or host counts (those stay on /state, settings.read).
  app.get('/admin/engines/active', { preHandler: app.requireAdmin }, async () => {
    const fleet = await readFleetEngineState(ctx.db);
    return ok({ engines: ENGINES.map((engine) => ({ engine, label: ENGINE_LABELS[engine], enabled: fleet[engine] })) });
  });

  app.get('/admin/engines/state', { preHandler: app.requireAdmin }, async () => {
    return ok({ engines: await listEngineStates(ctx.db) });
  });

  app.post('/admin/engines/:engine/state', { preHandler: app.requireAdmin }, async (req) => {
    const { engine } = req.params as { engine?: string };
    const normalized = typeof engine === 'string' ? engine.trim().toLowerCase() : '';
    if (!isEngine(normalized)) {
      throw new ValidationError('engine must be "codex", "claude", "grok" or "kimi"', { param: 'engine' });
    }
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      throw new ValidationError('enabled must be boolean', { param: 'enabled' });
    }
    const actor = req.admin?.user.username ?? null;
    if (body.enabled) await assertNoDestroyRequest(ctx.db, normalized);
    const change = await setFleetEngineEnabled(ctx.db, normalized, body.enabled, actor);
    const row = (await listEngineStates(ctx.db)).find((r) => r.engine === normalized);
    return ok({ ...row, previous: change.previous, hosts_suspended: change.hosts_suspended });
  });

  const engineParam = (req: { params: unknown }) => {
    const { engine } = req.params as { engine?: string };
    const normalized = typeof engine === 'string' ? engine.trim().toLowerCase() : '';
    if (!isEngine(normalized)) {
      throw new ValidationError('engine must be "codex", "claude", "grok" or "kimi"', { param: 'engine' });
    }
    return normalized;
  };

  app.get('/admin/engines/:engine/destroy', { preHandler: app.requireAdmin }, async (req) => {
    return ok(await listDestroyProgress(ctx.db, engineParam(req)));
  });

  app.post('/admin/engines/:engine/destroy', { preHandler: app.requireAdmin }, async (req) => {
    const engine = engineParam(req);
    const body = (req.body ?? {}) as { confirm?: unknown };
    return ok(await requestEngineDestroy(ctx.db, engine, body.confirm, req.admin?.user.username ?? null));
  });

  app.post('/admin/engines/:engine/destroy/purge', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { force?: unknown };
    return ok(
      await purgeEngineServerData(ctx.db, engineParam(req), {
        force: body.force === true,
        actor: req.admin?.user.username ?? null,
      }),
    );
  });

  app.delete('/admin/engines/:engine/destroy', { preHandler: app.requireAdmin }, async (req) => {
    return ok(await cancelEngineDestroy(ctx.db, engineParam(req), req.admin?.user.username ?? null));
  });
}

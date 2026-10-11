import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { HostSpawnService, HOST_SPAWN_ENABLED_KEY } from '../services/host-spawn.js';
import { SettingsService } from '../services/settings.js';
import { AdminEventsService } from '../services/admin-events.js';
import { createHostAuthService } from '../services/host-auth.js';
import { ValidationError } from '../http/errors.js';

export async function registerHostSpawnRoutes(app: FastifyInstance, ctx: RouteContext) {
  const service = new HostSpawnService(ctx);
  const settings = new SettingsService(ctx.db);
  const auth = createHostAuthService(ctx);
  app.get('/admin/host-spawn/state', { preHandler: app.requireAdmin }, async () => ({
    enabled: await service.enabled(), vip_required: true,
  }));
  app.post('/admin/host-spawn/state', { preHandler: app.requireAdmin }, async req => {
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    await settings.setFlag(HOST_SPAWN_ENABLED_KEY, parsed.data.enabled);
    await new AdminEventsService(ctx.db).record({ type: 'host.spawn.state_changed',
      payload: { enabled: parsed.data.enabled, admin_user_id: req.admin!.user.id } });
    return { enabled: parsed.data.enabled, vip_required: true };
  });
  app.post('/host/spawn/setup-complete', async req => {
    const host = await auth.authenticate(req);
    return service.complete(host.id);
  });
}

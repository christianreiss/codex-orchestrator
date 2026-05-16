import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import { registerAdminJoplinRoutes } from '../admin/joplin/index.js';
import { registerAdminManualRoutes } from '../admin/manual/index.js';

/**
 * Barrel for Phase 2.9 (Joplin integration + admin manual).
 *
 * The integration phase wires this in alongside the other Phase-2 worktrees.
 * Until then, importing this module is a no-op — calling
 * `registerJoplinManualRoutes(app, ctx)` mounts the four `/admin/joplin/*`
 * endpoints and the three `/admin/manual/*` endpoints.
 */
export async function registerJoplinManualRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  await registerAdminJoplinRoutes(app, ctx);
  await registerAdminManualRoutes(app, ctx);
}

export { registerAdminJoplinRoutes } from '../admin/joplin/index.js';
export { registerAdminManualRoutes } from '../admin/manual/index.js';

/**
 * Phase 2.5 (BACKEND-redo) barrel for the admin-content slice:
 *   - /admin/config/* (TOML render + store)
 *   - /admin/agents/* (multi-version document store)
 *   - /admin/skills/* (CRUD + soft-delete)
 *   - /admin/mcp/{memories,logs}
 *   - /admin/projects/* (CRUD + per-project notes/todos/files/feedback)
 *
 * The Phase 3 integration step adds `registerAdminContentRoutes(app, ctx)`
 * to `routes/index.ts`. Until then this module owns the route tree exposed
 * in the BACKEND-redo plan.
 */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import { registerAdminConfigRoutes } from '../admin/config/index.js';
import { registerAdminProjectsRoutes } from '../admin/projects/index.js';

export async function registerAdminContentRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  await registerAdminConfigRoutes(app, ctx);
  await registerAdminProjectsRoutes(app, ctx);
}

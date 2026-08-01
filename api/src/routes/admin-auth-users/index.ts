import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import { registerAdminAuthRoutes } from '../admin/auth/index.js';
import { registerAdminUsersRoutes } from '../admin/users/index.js';
import { registerAdminSetupRoutes } from '../admin/setup/index.js';

/**
 * Phase-2.2 barrel. Top-level `routes/index.ts` will call this single
 * function so the integration phase wires the worktree's surface area with a
 * one-line edit upstream.
 */
export async function registerAdminAuthAndUsersRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  await registerAdminAuthRoutes(app, ctx);
  await registerAdminSetupRoutes(app, ctx);
  await registerAdminUsersRoutes(app, ctx);
}

export { registerAdminAuthRoutes, registerAdminUsersRoutes };

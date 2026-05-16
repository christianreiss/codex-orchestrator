/**
 * Barrel for the Phase 2.4 worktree's two route trees. The top-level
 * `routes/index.ts` calls `registerAdminOverviewSettingsRoutes` to mount both
 * at once.
 */

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import { registerAdminOverviewRoutes } from '../admin/overview/index.js';
import { registerAdminSettingsRoutes } from '../admin/settings/index.js';

export async function registerAdminOverviewSettingsRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  await registerAdminOverviewRoutes(app, ctx);
  await registerAdminSettingsRoutes(app, ctx);
}

export { registerAdminOverviewRoutes } from '../admin/overview/index.js';
export { registerAdminSettingsRoutes } from '../admin/settings/index.js';

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import { registerAgentPortalAdminHostRoutes } from './admin-host.js';
import { registerAgentPortalPublicRoutes } from './public.js';

export async function registerAgentPortalRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  await registerAgentPortalAdminHostRoutes(app, ctx);
  await registerAgentPortalPublicRoutes(app, ctx);
}

/**
 * Barrel for Phase 2.6 — projects-client + MCP routes. The integration
 * worktree adds a single `registerProjectsMcpRoutes(app, ctx)` call to
 * `routes/index.ts`.
 */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import { registerProjectsClientRoutes } from '../projects-client/index.js';
import { registerMcpRoutes } from '../mcp/index.js';

export async function registerProjectsMcpRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  await registerProjectsClientRoutes(app, ctx);
  await registerMcpRoutes(app, ctx);
}

export { registerProjectsClientRoutes, registerMcpRoutes };

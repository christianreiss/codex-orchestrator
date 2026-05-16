/**
 * Aggregate registration entry-point for the OpenAI-compat worktree. The
 * integration step in Phase 3 wires this into `routes/index.ts` so admins
 * never get an OpenAI route mounted without its admin counterpart.
 */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import { registerOpenAiCompatRoutes } from '../v1/index.js';
import { registerAdminOpenAiKeyRoutes } from '../admin/keys/openai.js';

export async function registerOpenAiCompatWorktree(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  await registerOpenAiCompatRoutes(app, ctx);
  await registerAdminOpenAiKeyRoutes(app, ctx);
}

export { registerOpenAiCompatRoutes } from '../v1/index.js';
export { registerAdminOpenAiKeyRoutes } from '../admin/keys/openai.js';

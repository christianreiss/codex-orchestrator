/**
 * Phase 2.8 barrel — single entry point that wires both the public
 * /anthropic/v1/* surface AND the admin /admin/claude/keys/* surface.
 *
 * Phase 3 integration plugs this into `routes/index.ts` with one line:
 *
 *   await registerAnthropicCompatBundle(app, ctx);
 */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import {
  registerAnthropicCompatRoutes,
  type RegisterAnthropicCompatOptions,
} from '../anthropic-v1/index.js';
import { registerAdminClaudeKeyRoutes } from '../admin/keys/claude.js';

export async function registerAnthropicCompatBundle(
  app: FastifyInstance,
  ctx: RouteContext,
  options: RegisterAnthropicCompatOptions = {},
): Promise<void> {
  await registerAnthropicCompatRoutes(app, ctx, options);
  await registerAdminClaudeKeyRoutes(app, ctx);
}

export { registerAnthropicCompatRoutes } from '../anthropic-v1/index.js';
export { registerAdminClaudeKeyRoutes } from '../admin/keys/claude.js';
export type { RegisterAnthropicCompatOptions } from '../anthropic-v1/index.js';

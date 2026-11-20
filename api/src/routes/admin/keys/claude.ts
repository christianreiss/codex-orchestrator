import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { gatewayKeyHandlers } from './gateway-keys.js';

/**
 * Admin CRUD for the Anthropic-compatible `sk-ant-` keys (`engine = claude`).
 * Validation, record shape, audit and WS events are shared with the OpenAI,
 * Grok and Kimi surfaces; see gateway-keys.ts.
 */
export async function registerAdminClaudeKeyRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const keys = gatewayKeyHandlers(ctx, 'claude');
  app.get('/admin/claude/keys', { preHandler: [app.requireAdmin] }, keys.list);
  app.post('/admin/claude/keys', { preHandler: [app.requireAdmin] }, keys.create);
  app.post('/admin/claude/keys/:id/toggle', { preHandler: [app.requireAdmin] }, keys.toggle);
  app.delete('/admin/claude/keys/:id', { preHandler: [app.requireAdmin] }, keys.remove);
}

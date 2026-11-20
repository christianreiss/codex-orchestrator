import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { gatewayKeyHandlers } from './gateway-keys.js';

/**
 * Admin CRUD for the codex-scoped OpenAI bearer keys (`engine = codex`).
 * Validation, record shape, audit and WS events are shared with the Claude,
 * Grok and Kimi surfaces; see gateway-keys.ts.
 */
export async function registerAdminOpenAiKeyRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const keys = gatewayKeyHandlers(ctx, 'openai');
  app.get('/admin/openai/keys', { preHandler: [app.requireAdmin] }, keys.list);
  app.post('/admin/openai/keys', { preHandler: [app.requireAdmin] }, keys.create);
  app.post('/admin/openai/keys/:id/toggle', { preHandler: [app.requireAdmin] }, keys.toggle);
  app.delete('/admin/openai/keys/:id', { preHandler: [app.requireAdmin] }, keys.remove);
}

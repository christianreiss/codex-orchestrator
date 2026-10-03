import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import { registerOpenAiCompatRoutes, type OpenAiCompatOverrides } from '../v1/index.js';

/**
 * Grok's OpenAI-wire gateway surface, mounted under `/grok`. Which engine
 * answers it is routed per request (Grok by default); the Grok backend — and
 * its single central auth owner — lives in `gateway-backends.ts`.
 */
export async function registerGrokCompatRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  overrides: OpenAiCompatOverrides = {},
): Promise<void> {
  const options: OpenAiCompatOverrides = { ...overrides, surface: 'grok' };
  await app.register(async scoped => registerOpenAiCompatRoutes(scoped, ctx, options), { prefix: '/grok' });
}

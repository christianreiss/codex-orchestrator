import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { AgentReceiverService } from '../services/agent-receiver.js';
import { UnauthorizedError } from '../http/errors.js';

const generation = z.string().uuid();
const source = z.enum(['peer', 'portal']);
export async function registerAgentReceiverRoutes(app: FastifyInstance, ctx: RouteContext) {
  const service = new AgentReceiverService(ctx.db, ctx.env, ctx.keyring);
  const base = '/host/agent-sessions/:id/receiver/';
  for (const op of ['register', 'heartbeat', 'stop', 'ack', 'status', 'claim'] as const) {
    app.post(base + op, async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const token = req.headers['x-agent-bridge-token'];
      if (typeof token !== 'string')
        throw new UnauthorizedError('Bridge token required', 'agent_bridge_token_required');
      if (op === 'status') return service.status(id, token);
      if (op === 'register')
        return service.register(
          id,
          token,
          z
            .object({
              generation,
              protocol: z.enum(['codex-queue-v1', 'claude-channel-v1']),
              native_session_id: z.string().min(1).max(255),
            })
            .strict()
            .parse(req.body),
        );
      if (op === 'claim') {
        const body = z.object({ generation, source, claim_id: z.string().uuid() }).strict().parse(req.body);
        return service.claim(id, token, body.generation, body.source, body.claim_id);
      }
      const body = z
        .object({
          generation,
          source: source.optional(),
          nonce: z.string().uuid().optional(),
          failure: z.string().max(255).optional(),
        })
        .strict()
        .parse(req.body);
      return service.update(id, token, body.generation, op, body);
    });
  }
  app.post('/admin/agent-sessions/:id/receiver/verify', { preHandler: app.requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return service.retry(id);
  });
}

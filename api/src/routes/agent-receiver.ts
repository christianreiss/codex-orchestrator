import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { AgentReceiverService } from '../services/agent-receiver.js';
import { UnauthorizedError } from '../http/errors.js';
import { armWake } from '../http/idle-hold.js';
import { clientGone } from '../http/long-poll.js';
import { RECEIVER_CLAIM_GATES, RECEIVER_CLAIM_GATE_MAX_SECONDS } from '../services/agent-receiver-state.js';

const generation = z.string().uuid();
const source = z.enum(['peer', 'portal']);
const claimGate = z.object({
  state: z.enum(RECEIVER_CLAIM_GATES),
  seconds: z.number().int().min(0).max(RECEIVER_CLAIM_GATE_MAX_SECONDS),
}).strict();
/**
 * Every live session polls receiver/claim about once a second and almost always gets nothing (2026-10-22: 11.5 of
 * 24 HTTP requests/s). An empty claim is now held open for up to this long and answered again, once, as soon as a
 * message, portal or fleet-switch event is published. Old wrappers keep working: their client allows 35 s and they
 * still sleep one second between claims. Changes without an event (lease expiry, retry due) are seen on the next
 * claim, i.e. within this hold plus that second. 20 s (2026-10-23, was 8 s) keeps the receiver's own 15 s heartbeat,
 * which runs between claims, well inside the 45 s freshness window.
 */
export const RECEIVER_IDLE_HOLD_MS = 20_000;

function wakesReceiver(sessionId: string) {
  return (type: string, payload: unknown) => {
    if (type === 'agent_messaging.message.changed' || /^(settings\.|engine\.|agent_messaging\.state\.)/.test(type)) return true;
    if (type !== 'agent_portal.sessions.changed') return false;
    const target = (payload as { session_id?: unknown } | null)?.session_id;
    return target === undefined || target === sessionId;
  };
}

const emptyClaim = (result: unknown) =>
  !!result && typeof result === 'object' && Object.keys(result).length === 1 &&
  ((result as { delivery?: unknown }).delivery === null || (result as { message?: unknown }).message === null);

export async function registerAgentReceiverRoutes(app: FastifyInstance, ctx: RouteContext) {
  const service = new AgentReceiverService(ctx.db, ctx.env, ctx.keyring);
  type Op = 'register' | 'heartbeat' | 'stop' | 'ack' | 'status' | 'claim';
  // One handler per op, registered under literal paths so the source-indexed
  // route checks (registered-routes.ts) can see every receiver route.
  const handler = (op: Op) => async (req: FastifyRequest, reply: FastifyReply) => {
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
            protocol: z.enum(['codex-queue-v1', 'claude-channel-v1', 'grok-acp-v1']),
            native_session_id: z.string().min(1).max(255),
            capabilities: z.object({ delivery_timing_v1: z.boolean().optional(), queue_delivery_v1: z.boolean().optional(), peer_batch_v1: z.boolean().optional(), claim_gate_v1: z.boolean().optional() }).strict().optional(),
          })
          .strict()
          .parse(req.body),
      );
    if (op === 'claim') {
      const body = z.object({ generation, source, claim_id: z.string().uuid(), informational_only: z.boolean().optional(), immediate_only: z.boolean().optional() }).strict().parse(req.body);
      const claim = () => service.claim(id, token, body.generation, body.source, body.claim_id, body.informational_only, body.immediate_only);
      const wake = armWake(wakesReceiver(id));
      let result: Awaited<ReturnType<typeof claim>>;
      try {
        result = await claim();
      } catch (error) {
        wake.stop();
        throw error;
      }
      if (!emptyClaim(result)) {
        wake.stop();
        return result;
      }
      // An empty answer grants nothing; holding it changes only when the next durable check happens.
      return (await wake.wait(RECEIVER_IDLE_HOLD_MS, () => clientGone(reply), reply.raw)) && !clientGone(reply) ? claim() : result;
    }
    const schema = z
      .object({
        generation,
        source: source.optional(),
        nonce: z.string().uuid().optional(),
        failure: z.string().max(255).optional(),
      })
      .strict();
    const body = (op === 'heartbeat' ? schema.extend({ claim_gate: claimGate.optional() }) : schema).parse(req.body);
    return service.update(id, token, body.generation, op, body);
  };
  app.post('/host/agent-sessions/:id/receiver/register', handler('register'));
  app.post('/host/agent-sessions/:id/receiver/heartbeat', handler('heartbeat'));
  app.post('/host/agent-sessions/:id/receiver/stop', handler('stop'));
  app.post('/host/agent-sessions/:id/receiver/ack', handler('ack'));
  app.post('/host/agent-sessions/:id/receiver/status', handler('status'));
  app.post('/host/agent-sessions/:id/receiver/claim', handler('claim'));
  app.post('/admin/agent-sessions/:id/receiver/verify', { preHandler: app.requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return service.retry(id);
  });
}

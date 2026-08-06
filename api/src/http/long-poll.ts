import type { FastifyReply } from 'fastify';

/**
 * Reports whether the client behind a long poll has gone away, so the loop can
 * stop early instead of holding a worker for a socket nobody is reading.
 *
 * It has to be the *reply* stream. The obvious `req.raw.destroyed` is wrong in a
 * way that reads as correct: `IncomingMessage` is a readable, and Node
 * auto-destroys a readable once it ends. Fastify parses the JSON body before the
 * handler runs, so by the first `await` inside the loop the request stream has
 * already ended and destroyed itself on a perfectly healthy connection. Measured
 * on Fastify 5 / Node 22: `false` on handler entry, `true` 50 ms later, with the
 * client still waiting.
 *
 * Every long poll that guarded on it therefore returned empty on its first
 * iteration — a 20-second wait that answered in 0.1 s. That is not a slow poll,
 * it is a busy one: `cxx portal wait` and `agent_wait` both re-ask immediately,
 * and on the portal relay each re-ask is a fresh model turn.
 *
 * `ServerResponse` is destroyed only when the connection actually drops, which
 * is the question being asked. The SSE stream in `agent-portal/public.ts` was
 * already using it.
 */
export function clientGone(reply: FastifyReply): boolean {
  return reply.raw.destroyed;
}

import type { FastifyReply } from 'fastify';

/**
 * Reply helpers. Handlers either:
 *   return ok(data)           — auto-shaped by the onSend envelope plugin
 *   throw new ApiError(...)   — auto-shaped by the global error handler
 *   opt out of the envelope for binary / SSE bodies, in one of two spellings:
 *     raw(reply).code(200).send(body) — the helper below, which returns the
 *       same reply so the call stays chainable
 *     reply.envelopeRaw = true        — the bare flag, set before sending
 *
 * Either spelling sets reply.envelopeRaw=true, which bypasses the onSend
 * envelope rewrite (useful for binary downloads, raw text scripts, SSE
 * streams, signed-JSON responses). Note that reply.raw is Fastify's underlying
 * Node ServerResponse object, not a function to call in its place.
 */

declare module 'fastify' {
  interface FastifyReply {
    envelopeRaw?: boolean;
  }
}

export function ok<T>(data?: T): { ok: true; data: T | undefined } {
  return { ok: true, data };
}

export function raw(reply: FastifyReply): FastifyReply {
  reply.envelopeRaw = true;
  return reply;
}

export function isOkResult(x: unknown): x is { ok: true; data: unknown } {
  return Boolean(
    x && typeof x === 'object' && (x as Record<string, unknown>).ok === true && 'data' in x,
  );
}

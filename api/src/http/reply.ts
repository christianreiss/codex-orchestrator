import type { FastifyReply } from 'fastify';

/**
 * Reply helpers. Handlers either:
 *   return ok(data)           — auto-shaped by the onSend envelope plugin
 *   throw new ApiError(...)   — auto-shaped by the global error handler
 *   call reply.raw(...) directly for binary / SSE bodies
 *
 * Setting reply.envelopeRaw=true bypasses the onSend envelope rewrite (useful
 * for binary downloads, raw text scripts, SSE streams, signed-JSON responses).
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

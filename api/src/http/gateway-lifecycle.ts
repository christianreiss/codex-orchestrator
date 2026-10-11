import type { FastifyInstance, FastifyReply } from 'fastify';
import { ApiError } from './errors.js';

/** Cancel generation when its caller leaves or before Fastify drains requests. */
export function createGatewayLifecycle(app: FastifyInstance) {
  const active = new Set<AbortController>();
  let stopping = false;
  const shutdownReason = () => new ApiError('Gateway is shutting down.', {
    status: 503, code: 'gateway_stopping', type: 'api_error',
  });
  app.addHook('preClose', async () => {
    stopping = true;
    for (const controller of active) controller.abort(shutdownReason());
  });

  return async <T>(reply: FastifyReply, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const disconnected = () => {
      if (!reply.raw.writableEnded) {
        controller.abort(new ApiError('Generation request was cancelled.', {
          status: 499, code: 'request_cancelled', type: 'api_error',
        }));
      }
    };
    active.add(controller);
    reply.raw.once('close', disconnected);
    if (stopping) controller.abort(shutdownReason());
    else if (reply.raw.destroyed) disconnected();
    try {
      controller.signal.throwIfAborted();
      const result = await run(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      active.delete(controller);
      reply.raw.off('close', disconnected);
    }
  };
}

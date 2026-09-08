import type { FastifyInstance, FastifyReply } from 'fastify';

/** Close only this route group's SSE responses before Fastify drains sockets. */
export function createSseLifecycle(app: FastifyInstance): (reply: FastifyReply, onClose: () => void) => () => void {
  const streams = new Set<() => void>();
  let stopping = false;
  app.addHook('preClose', async () => {
    stopping = true;
    for (const stop of [...streams]) stop();
  });

  return (reply, onClose) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      streams.delete(stop);
      reply.raw.off('close', stop);
      onClose();
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        const socket = reply.raw.socket;
        reply.raw.end(() => {
          // A request admitted before preClose can become idle after Node's
          // initial idle-connection sweep. Finish this SSE socket once its
          // response is flushed so keep-alive cannot delay shutdown either.
          if (stopping && socket && !socket.destroyed) socket.end();
        });
      }
    };
    streams.add(stop);
    reply.raw.once('close', stop);
    // An already-admitted handler may finish its initial DB reads after
    // preClose. It must not create a fresh stream behind the draining server.
    if (stopping) stop();
    return stop;
  };
}

import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

/** Register before any socket routes, including when the admin socket is disabled. */
export async function registerWebsocketTransport(app: FastifyInstance): Promise<void> {
  if (!app.websocketServer) {
    await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
    app.addHook('onRoute', route => {
      // Fastify copies the original GET callback for automatic HEAD routes.
      // The websocket plugin skips HEAD, leaving that socket callback exposed to ordinary HTTP.
      if (route.method === 'HEAD' && route.websocket) {
        route.handler = (_request, reply) => reply.code(404).send();
      }
    });
  }
}

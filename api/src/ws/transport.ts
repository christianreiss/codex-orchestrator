import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

/** Register before any socket routes, including when the admin socket is disabled. */
export async function registerWebsocketTransport(app: FastifyInstance): Promise<void> {
  if (!app.websocketServer) {
    await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  }
}

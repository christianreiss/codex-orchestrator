import { once } from 'node:events';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerWebsocketTransport } from '../../../src/ws/transport.js';

it('keeps HTTP GET and HEAD out of the socket callback and authenticates both before replying', async () => {
  const app = Fastify();
  let dispatches = 0;
  try {
    await registerWebsocketTransport(app);
    app.get('/ws', {
      websocket: true,
      preHandler: (req, reply, done) => {
        if (!req.headers.authorization) { reply.code(401).send(); return; }
        done();
      },
    }, socket => {
      dispatches++;
      socket.on('message', () => socket.send('pong'));
    });
    const headers = { authorization: 'synthetic' };
    for (const method of ['GET', 'HEAD'] as const) {
      expect((await app.inject({ method, url: '/ws' })).statusCode).toBe(401);
      const response = await app.inject({ method, url: '/ws', headers });
      expect({ method, dispatches, status: response.statusCode, body: response.body })
        .toEqual({ method, dispatches: 0, status: 404, body: '' });
    }
    const client = await app.injectWS('/ws', { headers });
    try {
      const received = once(client, 'message');
      client.send('ping');
      const [message] = await received;
      expect(message.toString()).toBe('pong');
      expect(dispatches).toBe(1);
    } finally { client.terminate(); }
  } finally { await app.close(); }
});

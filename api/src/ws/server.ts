import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { Env } from '../env.js';
import { wsPublisher } from './publisher.js';
import { nowIso } from '../util/timestamp.js';
import { UnauthorizedError } from '../http/errors.js';

interface Socket {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

interface WsConnection {
  socket: Socket;
}

export async function registerWsServer(app: FastifyInstance, env: Env): Promise<void> {
  if (!env.ADMIN_WS_ENABLED) return;
  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 1024,
    },
  });

  wsPublisher.setBacklogCap(env.ADMIN_WS_BACKLOG_LIMIT ?? 1000);

  app.get(
    '/admin/ws',
    {
      websocket: true,
      preHandler: async (req: FastifyRequest) => {
        const ctx = await app.resolveAdmin?.(req);
        if (!ctx) throw new UnauthorizedError('Admin session required', 'admin_required');
      },
    },
    (connection: WsConnection) => {
      const socket = connection.socket;
      socket.send(JSON.stringify({ type: 'hello', ts: nowIso() }));
      const unsub = wsPublisher.subscribe((evt) => {
        if (socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify(evt));
        } catch {
          /* drop */
        }
      });
      const interval = setInterval(() => {
        if (socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify({ type: 'ping', ts: nowIso() }));
        } catch {
          /* drop */
        }
      }, (env.ADMIN_WS_HEARTBEAT_SECONDS ?? 30) * 1000);
      socket.on('close', () => {
        clearInterval(interval);
        unsub();
      });
      socket.on('error', () => {
        clearInterval(interval);
        unsub();
      });
    },
  );
}

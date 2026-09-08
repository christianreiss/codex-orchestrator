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
    (socket: Socket, req: FastifyRequest) => {
      socket.send(JSON.stringify({ type: 'hello', ts: nowIso() }));
      let closed = false;
      let checking = false;
      let authDeadline: ReturnType<typeof setTimeout> | undefined;
      const unsub = wsPublisher.subscribe((evt) => {
        if (closed || socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify(evt));
        } catch {
          /* drop */
        }
      });
      const interval = setInterval(() => {
        if (closed || checking || socket.readyState !== 1) return;
        checking = true;
        authDeadline = setTimeout(() => {
          cleanup();
          try { socket.close(); } catch { /* already gone */ }
        }, 10_000);
        void (async () => {
          try {
            const ctx = await app.resolveAdmin?.(req);
            if (closed || socket.readyState !== 1) return;
            if (!ctx) {
              cleanup();
              socket.close();
              return;
            }
            socket.send(JSON.stringify({ type: 'ping', ts: nowIso() }));
          } catch {
            // A database outage during re-auth must neither keep an unchecked
            // subscriber live nor become an unhandled rejection in the API.
            cleanup();
            try { socket.close(); } catch { /* already gone */ }
          } finally {
            clearTimeout(authDeadline);
            authDeadline = undefined;
            checking = false;
          }
        })();
      }, (env.ADMIN_WS_HEARTBEAT_SECONDS ?? 30) * 1000);
      function cleanup(): void {
        closed = true;
        clearInterval(interval);
        clearTimeout(authDeadline);
        authDeadline = undefined;
        unsub();
      }
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    },
  );
}

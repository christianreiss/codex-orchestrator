import type { FastifyInstance, FastifyRequest } from 'fastify';
import { registerWebsocketTransport } from './transport.js';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { resolveOwnerAdmin } from '../control-plane/state/admission.js';
import { sha256 } from '../security/hash.js';
import { wsPublisher } from './publisher.js';
import { nowIso } from '../util/timestamp.js';
import { UnauthorizedError } from '../http/errors.js';

interface Socket {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}
interface Admission { expiresAt: string }

export async function registerWsServer(app: FastifyInstance, env: Env, db?: Database): Promise<void> {
  if (!env.ADMIN_WS_ENABLED) return;
  await registerWebsocketTransport(app);
  wsPublisher.setBacklogCap(env.ADMIN_WS_BACKLOG_LIMIT ?? 1000);
  const admissions = new WeakMap<FastifyRequest, Admission>();

  app.get('/admin/ws', {
    websocket: true,
    preHandler: async (req: FastifyRequest) => {
      let expiresAt: string | undefined;
      if (db) {
        const runtime = ownerRuntimeFor(db);
        runtime?.assertOwner();
        const raw = req.cookies?.[env.ADMIN_SESSION_COOKIE];
        const ctx = runtime && raw ? resolveOwnerAdmin(db, sha256(raw)) : null;
        expiresAt = ctx?.session.expiresAt;
      } else {
        // Standalone route fixtures have no owner binding. Production passes db
        // and fails closed until owner hydration and writer fencing complete.
        const ctx = await app.resolveAdmin?.(req);
        expiresAt = ctx?.session.expiresAt;
      }
      if (!expiresAt || !(Date.parse(expiresAt) > Date.now())) throw new UnauthorizedError('Admin session required', 'admin_required');
      admissions.set(req, { expiresAt });
    },
  }, (socket: Socket, req: FastifyRequest) => {
    let closed = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let unsubscribeEvents = () => {};
    let unsubscribeState = () => {};
    const runtime = db ? ownerRuntimeFor(db) : undefined;
    const raw = req.cookies?.[env.ADMIN_SESSION_COOKIE];
    const tokenHash = raw ? sha256(raw) : null;
    let deadline = 0;

    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      interval = undefined;
      clearTimeout(expiry);
      unsubscribeEvents();
      unsubscribeState();
      admissions.delete(req);
    }
    function close(): void {
      cleanup();
      try { socket.close(); } catch { /* transport already gone */ }
    }
    function authorize(): boolean {
      if (closed || socket.readyState !== 1) return false;
      try {
        if (db && !runtime) { close(); return false; }
        runtime?.assertOwner();
        const admission = db
          ? tokenHash && resolveOwnerAdmin(db, tokenHash)?.session
          : admissions.get(req);
        const next = admission ? Date.parse(admission.expiresAt) : NaN;
        if (!(next > Date.now())) { close(); return false; }
        if (deadline !== next || !expiry) {
          deadline = next;
          clearTimeout(expiry);
          expiry = setTimeout(() => { expiry = undefined; authorize(); }, Math.min(2_147_483_647, Math.max(1, next - Date.now())));
          expiry.unref?.();
        }
        return true;
      } catch { close(); return false; }
    }
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    if (!authorize()) return;
    unsubscribeState = runtime?.state.subscribe(() => { authorize(); }) ?? (() => {});
    // Install the subscription before exposing its cursor. The handler does not
    // await between these statements, so no committed change can fall between.
    unsubscribeEvents = wsPublisher.subscribe(event => {
      if (!authorize()) return;
      try { socket.send(JSON.stringify(event)); } catch { close(); }
    });
    try { socket.send(JSON.stringify({ type: 'hello', ts: nowIso(), ...wsPublisher.cursor(), resync: true })); }
    catch { close(); return; }
    interval = setInterval(() => {
      if (closed || socket.readyState !== 1) return;
      try {
        runtime?.assertOwner();
        socket.send(JSON.stringify({ type: 'ping', ts: nowIso() }));
      } catch { close(); }
    }, (env.ADMIN_WS_HEARTBEAT_SECONDS ?? 30) * 1000);
    interval.unref?.();
  });
}

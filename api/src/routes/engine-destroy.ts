/**
 * POST /host/engine-destroy/report — a host reports progress of a fleet-wide
 * "destroy engine" request (`services/engine-destroy.ts`).
 *
 * Deliberately not gated by the engine master switch: destroying an engine
 * requires it to be suspended, and the report is the cleanup's own receipt.
 */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { ValidationError } from '../http/errors.js';
import { isEngine } from '../util/engine.js';
import { createHostAuthService } from '../services/host-auth.js';
import { createInsecureWindowService } from '../services/insecure-window.js';
import { recordHostReport } from '../services/engine-destroy.js';

export async function registerEngineDestroyRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const auth = createHostAuthService({ db: ctx.db, env: ctx.env, insecure: createInsecureWindowService({ db: ctx.db, env: ctx.env }) });
  app.post('/host/engine-destroy/report', async (req) => {
    const host = await auth.authenticate(req);
    const body = (req.body ?? {}) as { engine?: unknown; request_id?: unknown; status?: unknown; residue?: unknown };
    if (!isEngine(body.engine)) throw new ValidationError('engine must be codex, claude or grok', { param: 'engine' });
    if (typeof body.request_id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.request_id)) {
      throw new ValidationError('request_id must be a UUID', { param: 'request_id' });
    }
    if (typeof body.status !== 'string') throw new ValidationError('status is required', { param: 'status' });
    return recordHostReport(ctx.db, host.id, {
      engine: body.engine,
      request_id: body.request_id,
      status: body.status,
      residue: body.residue,
    });
  });
}

import {persistAuditLog} from '../services/audit-log.js';
import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { RouteContext } from './index.js';
import { hosts} from '../db/schema.js';
import { ENGINES, type Engine } from '../util/engine.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { createHostAuthService } from '../services/host-auth.js';
import { createInsecureWindowService } from '../services/insecure-window.js';
import { assertHostEngineEnabled } from '../services/host-engine-policy.js';
import { readFleetEngineState } from '../services/engine-switch.js';
import { housekeepingPolicy, housekeepingProtection, storeHousekeeping, reserveHousekeeping, releaseHousekeeping } from '../services/session-housekeeping.js';
import { wsPublisher } from '../ws/publisher.js';
import { SettingsService } from '../services/settings.js';
import { nowIso } from '../util/timestamp.js';

function engineOf(value: unknown): Engine {
  if (!ENGINES.includes(value as Engine)) throw new ValidationError('engine must be codex, claude or grok');
  return value as Engine;
}
export async function registerHousekeepingRoutes(app: FastifyInstance, ctx: RouteContext) {
  const auth = createHostAuthService({ db: ctx.db, env: ctx.env, insecure: createInsecureWindowService({ db: ctx.db, env: ctx.env }) });
  const policies = async (hostId?: number) => Object.fromEntries(await Promise.all(ENGINES.map(async engine => [engine, await housekeepingPolicy(ctx.db, engine, hostId)])));
  const hostId = async (value: unknown) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('invalid host id');
    const owner=ownerRuntimeFor(ctx.db);
    if (owner ? !owner.state.snapshot().hosts.has(id) : !(await ctx.db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, id)).limit(1)).length) throw new NotFoundError('Host not found');
    return id;
  };
  app.get('/admin/session-housekeeping', { preHandler: app.requireAdmin }, async () => policies());
  app.post<{ Params: { engine: string } }>('/admin/session-housekeeping/:engine', { preHandler: app.requireAdmin }, async req => {
    const engine=engineOf(req.params.engine);const result=await storeHousekeeping(ctx.db,engine,req.body);
    if(!ownerRuntimeFor(ctx.db))await persistAuditLog(ctx.db, {hostId:null,action:'admin.session_housekeeping',details:JSON.stringify({engine,policy:result}),createdAt:nowIso()});return result;
  });
  app.get<{ Params: { id: string } }>('/admin/hosts/:id/session-housekeeping', { preHandler: app.requireAdmin }, async req => {
    const id = await hostId(req.params.id);
    return { policies: await policies(id), last_run: await new SettingsService(ctx.db).getRaw(`session_housekeeping_report_host_${id}`) };
  });
  app.post<{ Params: { id: string; engine: string } }>('/admin/hosts/:id/session-housekeeping/:engine', { preHandler: app.requireAdmin }, async req => {
    const id = await hostId(req.params.id);
    const result = await storeHousekeeping(ctx.db, engineOf(req.params.engine), (req.body as { inherit?: boolean })?.inherit === true ? null : req.body, id);
    if(!ownerRuntimeFor(ctx.db))await persistAuditLog(ctx.db, {hostId:id,action:'admin.session_housekeeping',details:JSON.stringify({engine:req.params.engine,policy:result}),createdAt:nowIso()});
    wsPublisher.publish('host.updated', { id });
    return result;
  });
  const handler = (action: 'inspect' | 'reserve' | 'release' | 'report') => async (req: FastifyRequest) => {
      const host = await auth.authenticate(req);
      const body = req.body as { engine?: unknown; token?: unknown; report?: unknown };
      const engine = engineOf(body?.engine);
      assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
      if (action === 'inspect') return { policy: await housekeepingPolicy(ctx.db, engine, host.id), protected_ids: await housekeepingProtection(ctx.db, host.id, engine) };
      if (action === 'report') {
        const report = body.report as Record<string, unknown>;
        const safe: Record<string, unknown> = { engine, observed_at: nowIso() };
        for (const k of ['bytes_before', 'bytes_after', 'freed_bytes', 'deleted', 'protected', 'candidates', 'outcome']) {
          const v = report?.[k];
          if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 || k === 'outcome' && typeof v === 'string' && v.length <= 80) safe[k] = v;
        }
        await new SettingsService(ctx.db).set(`session_housekeeping_report_host_${host.id}`, JSON.stringify(safe), { publish: false });
        return { reported: true };
      }
      if (typeof body.token !== 'string' || !/^[0-9a-f-]{36}$/.test(body.token)) throw new ValidationError('a UUID journal token is required');
      if (action === 'reserve') return reserveHousekeeping(ctx.db, host.id, engine, body.token);
      await releaseHousekeeping(ctx.db, host.id, engine, body.token);
      return { released: true };
  };
  app.post('/host/session-housekeeping/inspect', handler('inspect'));
  app.post('/host/session-housekeeping/reserve', handler('reserve'));
  app.post('/host/session-housekeeping/release', handler('release'));
  app.post('/host/session-housekeeping/report', handler('report'));
}

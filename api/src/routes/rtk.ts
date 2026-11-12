import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { RouteContext } from './index.js';
import { hosts } from '../db/schema.js';
import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { ENGINES, isEngine, type Engine } from '../util/engine.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import {
  assertHostEngineAssigned,
  assertHostEngineEnabled,
  hostEnginesList,
} from '../services/host-engine-policy.js';
import { readFleetEngineState } from '../services/engine-switch.js';
import { SettingsService } from '../services/settings.js';
import { createHostAuthService } from '../services/host-auth.js';
import { createInsecureWindowService } from '../services/insecure-window.js';
import {
  rtkPolicy,
  rtkReportKey,
  storeRtkPolicy,
  validateRtkEnabled,
  validateRtkReport,
} from '../services/rtk.js';
import { createRtkArtifactCache, loadRtkArtifact } from '../services/rtk-artifacts.js';
import { wsPublisher } from '../ws/publisher.js';

const engineOf = (value: string): Engine => {
  if (!isEngine(value)) throw new ValidationError('engine must be codex, claude, grok or kimi');
  return value;
};
export async function registerRtkRoutes(app: FastifyInstance, ctx: RouteContext) {
  const settings = new SettingsService(ctx.db);
  const artifactCache = createRtkArtifactCache();
  app.addHook('onClose', async () => artifactCache.close());
  const auth = createHostAuthService({
    db: ctx.db,
    env: ctx.env,
    insecure: createInsecureWindowService({ db: ctx.db, env: ctx.env }),
  });
  const getHost = async (value: string) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('invalid host id');
    const owner = ownerRuntimeFor(ctx.db);
    const host = owner
      ? owner.state.snapshot().hosts.get(id)
      : (await ctx.db.select().from(hosts).where(eq(hosts.id, id)).limit(1))[0];
    if (!host) throw new NotFoundError('Host not found');
    return host;
  };
  app.get('/admin/rtk', { preHandler: app.requireAdmin }, async () => ({
    engines: Object.fromEntries(
      await Promise.all(ENGINES.map(async (engine) => [engine, await rtkPolicy(ctx.db, engine)])),
    ),
  }));
  app.post<{ Params: { engine: string } }>(
    '/admin/rtk/:engine',
    { preHandler: app.requireAdmin },
    async (req) => storeRtkPolicy(ctx.db, engineOf(req.params.engine), validateRtkEnabled(req.body)),
  );
  app.get<{ Params: { id: string } }>(
    '/admin/hosts/:id/rtk',
    { preHandler: app.requireAdmin },
    async (req) => {
      const host = await getHost(req.params.id);
      const assigned = hostEnginesList(host.engines);
      return {
        engines: Object.fromEntries(
          await Promise.all(
            ENGINES.map(async (engine) => {
              const report = await settings.getRaw(rtkReportKey(engine, host.id));
              return [
                engine,
                {
                  ...(await rtkPolicy(ctx.db, engine, host.id)),
                  assigned: assigned.includes(engine),
                  observation: report ? (JSON.parse(report) as unknown) : null,
                },
              ];
            }),
          ),
        ),
      };
    },
  );
  app.post<{ Params: { id: string; engine: string } }>(
    '/admin/hosts/:id/rtk/:engine',
    { preHandler: app.requireAdmin },
    async (req) => {
      const host = await getHost(req.params.id);
      const engine = engineOf(req.params.engine);
      assertHostEngineAssigned(host, engine);
      return storeRtkPolicy(ctx.db, engine, validateRtkEnabled(req.body, true), host.id);
    },
  );
  app.post('/host/rtk/report', async (req) => {
    const host = await auth.authenticate(req);
    const engine = engineOf((req.body as { engine?: string } | null)?.engine ?? '');
    assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
    const report = validateRtkReport(req.body, new Date().toISOString());
    await settings.set(rtkReportKey(engine, host.id), JSON.stringify(report), { publish: false });
    wsPublisher.publish('host.updated', { id: host.id });
    return { reported: true };
  });
  app.get<{ Params: { version: string; platform: string }; Querystring: { engine?: string } }>(
    '/wrapper/v2/rtk/v:version/:platform',
    { preHandler: [app.requireHost] },
    async (req, reply) => {
      const engine = engineOf(req.query.engine ?? '');
      if (!req.authHost) throw new NotFoundError('Host context missing');
      assertHostEngineEnabled(req.authHost, engine, await readFleetEngineState(ctx.db));
      const root = await artifactCache.root();
      const bytes = await loadRtkArtifact(root, req.params.platform, req.params.version);
      return reply
        .type('application/gzip')
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(bytes);
    },
  );
}

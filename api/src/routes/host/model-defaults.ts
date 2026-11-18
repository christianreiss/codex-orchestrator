import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteContext } from '../index.js';
import { ValidationError } from '../../http/errors.js';
import { createHostAuthService } from '../../services/host-auth.js';
import { createInsecureWindowService } from '../../services/insecure-window.js';
import { assertHostEngineEnabled } from '../../services/host-engine-policy.js';
import { readFleetEngineState } from '../../services/engine-switch.js';
import { ModelDefaultsService } from '../../services/model-defaults.js';
import { resolveEngineHints } from '../../util/engine-resolution.js';
import { addOwnerResponseProof } from '../../control-plane/state/runtime.js';
import { requestHost } from '../../control-plane/state/admission.js';
import { ownedEngineState } from '../../control-plane/state/messaging.js';

/** Explicit operator action in cxx: every active assigned host may set its
 * engine's fleet default. Host overrides are never changed by this route. */
export async function registerHostModelDefaultsRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const insecure = createInsecureWindowService({ db: ctx.db, env: ctx.env });
  const auth = createHostAuthService({ db: ctx.db, env: ctx.env, insecure });
  const defaults = new ModelDefaultsService(ctx.db);
  async function admit(req: FastifyRequest<{ Params: { engine: string } }>) {
    const host0 = await auth.authenticate(req, { checkApiDisabled: true });
    const engine = resolveEngineHints([
      { source: 'engine', value: req.params.engine },
      { source: 'X-Engine', value: req.headers['x-engine'] },
      { source: 'query engine', value: (req.query as { engine?: unknown } | undefined)?.engine },
    ])!;
    assertHostEngineEnabled(host0, engine, await readFleetEngineState(ctx.db));
    const host = host0.secure === 1 ? host0 : await insecure.enforce(host0, 'host_model_defaults', req.clientIp);
    addOwnerResponseProof(`host-model-defaults:${engine}`, snapshot => {
      const current = snapshot.hosts.get(host.id);
      if (!current) throw new ValidationError('Host no longer available');
      assertHostEngineEnabled(requestHost(current, host.apiKey), engine, ownedEngineState(snapshot));
    });
    return { host, engine };
  }
  app.get<{ Params: { engine: string } }>('/host/model-defaults/:engine', async req => {
    const { engine } = await admit(req);
    return defaults.get(engine);
  });
  app.post<{ Params: { engine: string }; Body: unknown }>('/host/model-defaults/:engine', async req => {
    const { host, engine } = await admit(req);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
      throw new ValidationError('model and reasoning_effort are required', { param: 'model' });
    const body = req.body as Record<string, unknown>;
    const extra = Object.keys(body).find(key => key !== 'model' && key !== 'reasoning_effort');
    if (extra) throw new ValidationError(`Unexpected field: ${extra}`, { param: extra });
    if (!Object.hasOwn(body, 'reasoning_effort'))
      throw new ValidationError('reasoning_effort is required (null for models without reasoning)', { param: 'reasoning_effort' });
    return defaults.set(engine, body, host.id);
  });
}

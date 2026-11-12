import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { isEngine } from '../util/engine.js';
import { ValidationError } from '../http/errors.js';
import { SettingsService } from '../services/settings.js';
import { speechInputPolicies } from '../services/speech-input.js';
export async function registerSpeechInputRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get('/admin/speech-input', { preHandler: app.requireAdmin }, () => speechInputPolicies(ctx.db));
  app.post<{ Params: { target: string } }>('/admin/speech-input/:target', { preHandler: app.requireAdmin }, async req => {
    const target = req.params.target;
    if (target !== 'global' && !isEngine(target)) throw new ValidationError('Invalid speech input target');
    const body = req.body as { enabled?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'enabled') || !(typeof body.enabled === 'boolean' || (target !== 'global' && body.enabled === null))) throw new ValidationError('enabled must be boolean, or null for engine inheritance');
    await new SettingsService(ctx.db).set(`speech_input_${target}`, body.enabled === null ? '' : String(body.enabled));
    return speechInputPolicies(ctx.db);
  });
}

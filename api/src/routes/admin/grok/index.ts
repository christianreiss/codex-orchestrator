import { appendAuditLog } from '../../../services/audit-log.js';
import { gatewayKeyHandlers } from '../keys/gateway-keys.js';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { ApiError, ValidationError } from '../../../http/errors.js';
import { SettingsService } from '../../../services/settings.js';
import { ClientConfigService } from '../../../services/client-config.js';
import { createGrokModelsService, GROK_DEFAULT_MODEL, normalizeGrokModel, type GrokModel } from '../../../services/grok-models.js';
import { normalizeBool } from '../../../services/config-normalizer.js';
import { logs } from '../../../db/schema.js';
import { nowIso } from '../../../util/timestamp.js';

export async function registerAdminGrokRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const settings = new SettingsService(ctx.db);
  const config = new ClientConfigService(ctx.db);
  const models = createGrokModelsService(ctx.db);
  async function audit(action: string, detail: Record<string, unknown>) {
    await appendAuditLog(ctx.db,{ action, engine: 'grok', details: JSON.stringify(detail), createdAt: nowIso() });
  }

  const keyRoutes = gatewayKeyHandlers(ctx, 'grok');
  app.get('/admin/grok/keys', { preHandler: app.requireAdmin }, keyRoutes.list);
  app.post('/admin/grok/keys', { preHandler: app.requireAdmin }, keyRoutes.create);
  app.post('/admin/grok/keys/:id/toggle', { preHandler: app.requireAdmin }, keyRoutes.toggle);
  app.delete('/admin/grok/keys/:id', { preHandler: app.requireAdmin }, keyRoutes.remove);

  app.get('/admin/grok/state', { preHandler: app.requireAdmin }, async () => ({ disabled: await settings.getFlag('grok_api_disabled', false) }));
  app.post('/admin/grok/state', { preHandler: app.requireAdmin }, async req => {
    const disabled = normalizeBool((req.body as { disabled?: unknown })?.disabled);
    if (disabled === null) throw new ValidationError('disabled must be boolean', { param: 'disabled' });
    await settings.setFlag('grok_api_disabled', disabled);
    await audit('admin.grok_api.state', { disabled });
    return { disabled };
  });
  async function proxySettings() {
    return { default_model: await settings.getString('grok_default_model', GROK_DEFAULT_MODEL), disabled: await settings.getFlag('grok_api_disabled', false) };
  }
  app.get('/admin/grok/settings', { preHandler: app.requireAdmin }, proxySettings);
  app.post('/admin/grok/settings', { preHandler: app.requireAdmin }, async req => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const extra = Object.keys(body).find(key => key !== 'default_model' && key !== 'disabled');
    if (extra) throw new ApiError(`Grok does not support ${extra}`, { status: 400, code: 'unsupported_parameter', param: extra });
    if (body.default_model !== undefined) {
      const model = normalizeGrokModel(body.default_model);
      if (!model) throw new ValidationError('Unsupported Grok model', { param: 'default_model' });
      await settings.set('grok_default_model', model);
    }
    if (body.disabled !== undefined) {
      const disabled = normalizeBool(body.disabled);
      if (disabled === null) throw new ValidationError('disabled must be boolean', { param: 'disabled' });
      await settings.setFlag('grok_api_disabled', disabled);
    }
    await audit('admin.grok_settings', { ...body });
    return proxySettings();
  });
  app.get('/admin/grok/models', { preHandler: app.requireAdmin }, async () => ({ models: await models.catalog() }));
  app.post('/admin/grok/models/:model/toggle', { preHandler: app.requireAdmin }, async req => {
    const model = normalizeGrokModel((req.params as { model: string }).model);
    const enabled = normalizeBool((req.body as { enabled?: unknown })?.enabled);
    if (!model || enabled === null) throw new ValidationError('Valid model and enabled flag are required');
    await models.setEnabled(model as GrokModel, enabled);
    await audit('grok.model.toggle', { model, enabled });
    return { model, enabled };
  });

  app.get('/admin/grok/config', { preHandler: app.requireAdmin }, () => config.adminFetch('grok'));
  app.get('/admin/grok/config/retrieve', { preHandler: app.requireAdmin }, () => config.adminFetch('grok'));
  app.post('/admin/grok/config/render', { preHandler: app.requireAdmin }, async req => config.render((req.body as { settings?: unknown })?.settings, 'grok'));
  app.post('/admin/grok/config/store', { preHandler: app.requireAdmin }, async req => config.store((req.body ?? {}) as { settings?: unknown; sha256?: unknown; expected_revision?: unknown }, null, 'grok'));
}

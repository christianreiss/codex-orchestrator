import { appendAuditLog } from '../../../services/audit-log.js';
import { gatewayKeyHandlers } from '../keys/gateway-keys.js';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { ApiError, ValidationError } from '../../../http/errors.js';
import { SettingsService } from '../../../services/settings.js';
import { ClientConfigService } from '../../../services/client-config.js';
import {
  createKimiModelsService,
  KIMI_DEFAULT_MODEL,
  normalizeKimiModel,
  type KimiModel,
} from '../../../services/kimi-models.js';
import { normalizeBool } from '../../../services/config-normalizer.js';
import { logs } from '../../../db/schema.js';
import { nowIso } from '../../../util/timestamp.js';

export async function registerAdminKimiRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const settings = new SettingsService(ctx.db);
  const config = new ClientConfigService(ctx.db);
  const models = createKimiModelsService(ctx.db);
  async function audit(action: string, detail: Record<string, unknown>) {
    await appendAuditLog(ctx.db, {
      action,
      engine: 'kimi',
      details: JSON.stringify(detail),
      createdAt: nowIso(),
    });
  }

  const keyRoutes = gatewayKeyHandlers(ctx, 'kimi');
  app.get('/admin/kimi/keys', { preHandler: app.requireAdmin }, keyRoutes.list);
  app.post('/admin/kimi/keys', { preHandler: app.requireAdmin }, keyRoutes.create);
  app.post('/admin/kimi/keys/:id/toggle', { preHandler: app.requireAdmin }, keyRoutes.toggle);
  app.delete('/admin/kimi/keys/:id', { preHandler: app.requireAdmin }, keyRoutes.remove);

  async function proxySettings() {
    return {
      default_model: await settings.getString('kimi_default_model', KIMI_DEFAULT_MODEL),
      disabled: await settings.getFlag('kimi_api_disabled', true),
    };
  }
  app.get('/admin/kimi/settings', { preHandler: app.requireAdmin }, proxySettings);
  app.post('/admin/kimi/settings', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const extra = Object.keys(body).find((key) => key !== 'default_model' && key !== 'disabled');
    if (extra)
      throw new ApiError(`Kimi does not support ${extra}`, {
        status: 400,
        code: 'unsupported_parameter',
        param: extra,
      });
    if (body.default_model !== undefined) {
      const model = normalizeKimiModel(body.default_model);
      if (!model) throw new ValidationError('Unsupported Kimi model', { param: 'default_model' });
      await settings.set('kimi_default_model', model);
    }
    if (body.disabled !== undefined) {
      const disabled = normalizeBool(body.disabled);
      if (disabled === null) throw new ValidationError('disabled must be boolean', { param: 'disabled' });
      await settings.setFlag('kimi_api_disabled', disabled);
    }
    await audit('admin.kimi_settings', { ...body });
    return proxySettings();
  });
  app.get('/admin/kimi/models', { preHandler: app.requireAdmin }, async () => ({
    models: await models.catalog(),
  }));
  app.post('/admin/kimi/models/:model/toggle', { preHandler: app.requireAdmin }, async (req) => {
    const model = normalizeKimiModel((req.params as { model: string }).model);
    const enabled = normalizeBool((req.body as { enabled?: unknown })?.enabled);
    if (!model || enabled === null) throw new ValidationError('Valid model and enabled flag are required');
    await models.setEnabled(model as KimiModel, enabled);
    await audit('kimi.model.toggle', { model, enabled });
    return { model, enabled };
  });

  app.get('/admin/kimi/config', { preHandler: app.requireAdmin }, () => config.adminFetch('kimi'));
  app.post('/admin/kimi/config/render', { preHandler: app.requireAdmin }, async (req) =>
    config.render((req.body as { settings?: unknown })?.settings, 'kimi'),
  );
  app.post('/admin/kimi/config/store', { preHandler: app.requireAdmin }, async (req) =>
    config.store(
      (req.body ?? {}) as { settings?: unknown; sha256?: unknown; expected_revision?: unknown },
      null,
      'kimi',
    ),
  );
}

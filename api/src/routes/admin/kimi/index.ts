import { appendAuditLog } from '../../../services/audit-log.js';
import { parseKeyBackend } from '../../../services/api-key-routing.js';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { ApiError, NotFoundError, ValidationError } from '../../../http/errors.js';
import { OpenAiKeyService } from '../../../services/openai-keys.js';
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
import { wsPublisher } from '../../../ws/publisher.js';

export async function registerAdminKimiRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const keys = new OpenAiKeyService({ db: ctx.db, keyring: ctx.keyring });
  const settings = new SettingsService(ctx.db);
  const config = new ClientConfigService(ctx.db);
  const models = createKimiModelsService(ctx.db);
  const idFrom = (params: unknown) => {
    const id = Number((params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('Invalid key id', { param: 'id' });
    return id;
  };
  async function audit(action: string, detail: Record<string, unknown>) {
    await appendAuditLog(ctx.db, {
      action,
      engine: 'kimi',
      details: JSON.stringify(detail),
      createdAt: nowIso(),
    });
  }
  const wireKey = (row: Awaited<ReturnType<typeof keys.issue>>['record']) => ({
    id: row.id,
    name: row.name,
    key_prefix: row.keyPrefix,
    is_active: row.isActive === 1,
    use_count: Number(row.useCount),
    last_used_at: row.lastUsedAt,
    expires_at: row.expiresAt,
    engine: 'kimi',
    backend_engine: row.backendEngine ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });

  app.get('/admin/kimi/keys', { preHandler: app.requireAdmin }, async () =>
    (await keys.listByEngine('kimi')).map((row) =>
      wireKey(row as Awaited<ReturnType<typeof keys.issue>>['record']),
    ),
  );
  app.post('/admin/kimi/keys', { preHandler: app.requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as { name?: unknown; expires_at?: unknown; backend_engine?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim())
      throw new ValidationError('name is required', { param: 'name' });
    const issued = await keys.issue({
      backendEngine: await parseKeyBackend(ctx.db, body.backend_engine),
      engine: 'kimi',
      name: body.name.trim(),
      adminUserId: req.admin?.user.id ?? null,
      expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null,
    });
    await audit('kimi.key.create', { key_id: issued.record.id, name: issued.record.name });
    wsPublisher.publish('apikey.created', { id: issued.record.id, engine: 'kimi' });
    return { key: issued.key, record: wireKey(issued.record) };
  });
  app.post('/admin/kimi/keys/:id/toggle', { preHandler: app.requireAdmin }, async (req) => {
    const id = idFrom(req.params);
    const active = normalizeBool((req.body as { active?: unknown })?.active);
    if (active === null) throw new ValidationError('active must be boolean', { param: 'active' });
    if (!(await keys.setActive(id, active, 'kimi'))) throw new NotFoundError('Key not found');
    await audit('kimi.key.toggle', { key_id: id, active });
    wsPublisher.publish('apikey.toggled', { id, engine: 'kimi', active });
    return { message: active ? 'Key enabled' : 'Key disabled' };
  });
  app.delete('/admin/kimi/keys/:id', { preHandler: app.requireAdmin }, async (req) => {
    const id = idFrom(req.params);
    if (!(await keys.delete(id, 'kimi'))) throw new NotFoundError('Key not found');
    await audit('kimi.key.delete', { key_id: id });
    wsPublisher.publish('apikey.deleted', { id, engine: 'kimi' });
    return { message: 'Key deleted' };
  });

  app.get('/admin/kimi/state', { preHandler: app.requireAdmin }, async () => ({
    disabled: await settings.getFlag('kimi_api_disabled', true),
  }));
  app.post('/admin/kimi/state', { preHandler: app.requireAdmin }, async (req) => {
    const disabled = normalizeBool((req.body as { disabled?: unknown })?.disabled);
    if (disabled === null) throw new ValidationError('disabled must be boolean', { param: 'disabled' });
    await settings.setFlag('kimi_api_disabled', disabled);
    await audit('admin.kimi_api.state', { disabled });
    return { disabled };
  });
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
  app.get('/admin/kimi/config/retrieve', { preHandler: app.requireAdmin }, () => config.adminFetch('kimi'));
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

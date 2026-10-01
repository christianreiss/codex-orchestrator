import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { ApiError, NotFoundError, ValidationError } from '../../../http/errors.js';
import { OpenAiKeyService } from '../../../services/openai-keys.js';
import { SettingsService } from '../../../services/settings.js';
import { ClientConfigService } from '../../../services/client-config.js';
import { createGrokModelsService, GROK_DEFAULT_MODEL, normalizeGrokModel, type GrokModel } from '../../../services/grok-models.js';
import { normalizeBool } from '../../../services/config-normalizer.js';
import { logs } from '../../../db/schema.js';
import { nowIso } from '../../../util/timestamp.js';
import { wsPublisher } from '../../../ws/publisher.js';

export async function registerAdminGrokRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const keys = new OpenAiKeyService({ db: ctx.db, keyring: ctx.keyring });
  const settings = new SettingsService(ctx.db);
  const config = new ClientConfigService(ctx.db);
  const models = createGrokModelsService(ctx.db);
  const idFrom = (params: unknown) => {
    const id = Number((params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('Invalid key id', { param: 'id' });
    return id;
  };
  async function audit(action: string, detail: Record<string, unknown>) {
    await ctx.db.insert(logs).values({ action, engine: 'grok', details: JSON.stringify(detail), createdAt: nowIso() });
  }
  const wireKey = (row: Awaited<ReturnType<typeof keys.issue>>['record']) => ({ id: row.id, name: row.name, key_prefix: row.keyPrefix, is_active: row.isActive === 1, use_count: Number(row.useCount), last_used_at: row.lastUsedAt, expires_at: row.expiresAt, engine: 'grok', created_at: row.createdAt, updated_at: row.updatedAt });

  app.get('/admin/grok/keys', { preHandler: app.requireAdmin }, async () => (await keys.listByEngine('grok')).map(row => wireKey(row as Awaited<ReturnType<typeof keys.issue>>['record'])));
  app.post('/admin/grok/keys', { preHandler: app.requireAdmin }, async req => {
    const body = (req.body ?? {}) as { name?: unknown; expires_at?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim()) throw new ValidationError('name is required', { param: 'name' });
    const issued = await keys.issue({ engine: 'grok', name: body.name.trim(), adminUserId: req.admin?.user.id ?? null, expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null });
    await audit('grok.key.create', { key_id: issued.record.id, name: issued.record.name });
    wsPublisher.publish('apikey.created', { id: issued.record.id, engine: 'grok' });
    return { key: issued.key, record: wireKey(issued.record) };
  });
  app.post('/admin/grok/keys/:id/toggle', { preHandler: app.requireAdmin }, async req => {
    const id = idFrom(req.params);
    const active = normalizeBool((req.body as { active?: unknown })?.active);
    if (active === null) throw new ValidationError('active must be boolean', { param: 'active' });
    if (!await keys.setActive(id, active, 'grok')) throw new NotFoundError('Key not found');
    await audit('grok.key.toggle', { key_id: id, active });
    wsPublisher.publish('apikey.toggled', { id, engine: 'grok', active });
    return { message: active ? 'Key enabled' : 'Key disabled' };
  });
  app.delete('/admin/grok/keys/:id', { preHandler: app.requireAdmin }, async req => {
    const id = idFrom(req.params);
    if (!await keys.delete(id, 'grok')) throw new NotFoundError('Key not found');
    await audit('grok.key.delete', { key_id: id });
    wsPublisher.publish('apikey.deleted', { id, engine: 'grok' });
    return { message: 'Key deleted' };
  });

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
  app.post('/admin/grok/config/store', { preHandler: app.requireAdmin }, async req => config.store((req.body ?? {}) as { settings?: unknown; sha256?: unknown }, null, 'grok'));
}

/**
 * Admin management of the stored provider API keys (`provider_api_keys`) and
 * of each gateway surface's default source.
 *
 *   GET    /admin/provider-keys                  providers + every key (metadata only)
 *   POST   /admin/provider-keys                  store a key {provider, label, key, base_url?}
 *   PATCH  /admin/provider-keys/:id              {label?, key?, base_url?}
 *   POST   /admin/provider-keys/:id/state        {state: "active"|"paused"}
 *   POST   /admin/provider-keys/:id/verify       GET {base_url}/models with the key, record the verdict
 *   POST   /admin/provider-keys/order            {provider, ids}: the provider's complete failover order
 *   DELETE /admin/provider-keys/:id
 *   POST   /admin/api/surfaces/:surface/source   {source: "emulated"|"upstream"}
 *
 * A key value is write-only: no response, audit row, log line or WS payload
 * carries it, its hash or its envelope; records show `key_hint` only. The
 * verification call uses the forward's guarded agent (same network policy).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteContext } from '../../index.js';
import { ApiError, ConflictError, NotFoundError } from '../../../http/errors.js';
import { ok } from '../../../http/reply.js';
import { API_SURFACES, API_SURFACE_IDS, isApiSource, isApiSurfaceId, listApiSurfaces, storedSource } from '../../../services/api-surfaces.js';
import { appendAuditLog } from '../../../services/audit-log.js';
import { assertFleetEngineEnabledForAdmin, readFleetEngineState } from '../../../services/engine-switch.js';
import { createGatewayUpstream, type GatewayUpstream } from '../../../services/gateway-upstream/index.js';
import { PROVIDERS, PROVIDER_IDS, isProviderId } from '../../../services/gateway-upstream/providers.js';
import type { ProviderKeyMeta } from '../../../services/provider-api-keys.js';
import { SettingsService } from '../../../services/settings.js';
import { nowIso } from '../../../util/timestamp.js';

function invalid(message: string, param?: string): ApiError {
  return new ApiError(message, { status: 400, code: 'invalid_request', type: 'invalid_request_error', param });
}

function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be a JSON object');
  return body as Record<string, unknown>;
}

function parseId(params: unknown): number {
  const raw = (params as { id?: unknown } | undefined)?.id;
  const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw invalid('Invalid key id', 'id');
  return id;
}

/** The wire record of one stored key: metadata only. */
export function toAdminProviderKey(row: ProviderKeyMeta) {
  const provider = isProviderId(row.provider) ? row.provider : null;
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    key_hint: row.keyHint,
    base_url: row.baseUrl ?? null,
    effective_base_url: row.baseUrl ?? (provider ? PROVIDERS[provider].defaultBaseUrl : null),
    sort_order: row.sortOrder,
    state: row.state,
    verification_state: row.verificationState,
    verification_reason: row.verificationReason ?? null,
    verification_checked_at: row.verificationCheckedAt ?? null,
    last_used_at: row.lastUsedAt ?? null,
    last_error_at: row.lastErrorAt ?? null,
    last_error_status: row.lastErrorStatus ?? null,
    last_error_reason: row.lastErrorReason ?? null,
    created_by_admin_user_id: row.createdByAdminUserId ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

async function recordLog(ctx: RouteContext, action: string, details: Record<string, unknown>): Promise<void> {
  try {
    await appendAuditLog(ctx.db, { hostId: null, action, details: JSON.stringify(details), createdAt: nowIso() });
  } catch {
    /* logging is best-effort */
  }
}

export async function registerAdminProviderKeyRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  options: { upstream?: GatewayUpstream } = {},
): Promise<void> {
  const upstream = options.upstream ?? createGatewayUpstream(ctx, { log: app.log });
  if (!options.upstream) app.addHook('onClose', async () => upstream.close());
  const keys = upstream.keys;
  const settings = new SettingsService(ctx.db);
  const record = async (id: number) => {
    const row = await keys.get(id);
    if (!row) throw new NotFoundError('Provider key not found', 'provider_key_not_found');
    return toAdminProviderKey(row);
  };

  app.get('/admin/provider-keys', { preHandler: app.requireAdmin }, async () => {
    const [rows, counts, engines, surfaces] = await Promise.all([
      keys.list(),
      keys.counts(),
      readFleetEngineState(ctx.db),
      listApiSurfaces(ctx.db),
    ]);
    return ok({
      providers: PROVIDER_IDS.map((id) => {
        const provider = PROVIDERS[id];
        const surface = surfaces.find((row) => row.provider === id);
        return {
          provider: id,
          label: provider.label,
          engine: provider.engine,
          engine_enabled: engines[provider.engine],
          default_base_url: provider.defaultBaseUrl,
          surface: surface?.surface ?? null,
          base_path: surface?.base_path ?? null,
          source: surface?.source ?? 'emulated',
          counts: counts[id],
        };
      }),
      keys: rows.map(toAdminProviderKey),
    });
  });

  app.post('/admin/provider-keys', { preHandler: app.requireAdmin }, async (req: FastifyRequest) => {
    const body = objectBody(req.body);
    const saved = await keys.create({
      provider: body.provider,
      label: body.label,
      key: body.key,
      base_url: body.base_url,
      adminUserId: req.admin?.user.id ?? null,
    });
    return ok(toAdminProviderKey(saved));
  });

  app.patch('/admin/provider-keys/:id', { preHandler: app.requireAdmin }, async (req: FastifyRequest) => {
    const id = parseId(req.params);
    const body = objectBody(req.body);
    const saved = await keys.update(id, { label: body.label, key: body.key, base_url: body.base_url });
    return ok(toAdminProviderKey(saved));
  });

  app.post('/admin/provider-keys/:id/state', { preHandler: app.requireAdmin }, async (req: FastifyRequest) => {
    const id = parseId(req.params);
    return ok(toAdminProviderKey(await keys.setState(id, objectBody(req.body).state)));
  });

  app.post('/admin/provider-keys/:id/verify', { preHandler: app.requireAdmin }, async (req: FastifyRequest) => {
    const id = parseId(req.params);
    const current = await keys.get(id);
    if (!current) throw new NotFoundError('Provider key not found', 'provider_key_not_found');
    // A verification is a provider call: a suspended engine makes none.
    if (isProviderId(current.provider)) await assertFleetEngineEnabledForAdmin(ctx.db, PROVIDERS[current.provider].engine);
    const verified = await upstream.verify(id);
    if (!verified) throw new NotFoundError('Provider key not found', 'provider_key_not_found');
    return ok(await record(id));
  });

  app.post('/admin/provider-keys/order', { preHandler: app.requireAdmin }, async (req: FastifyRequest) => {
    const body = objectBody(req.body);
    return ok({ keys: (await keys.reorder(body.provider, body.ids)).map(toAdminProviderKey) });
  });

  app.delete('/admin/provider-keys/:id', { preHandler: app.requireAdmin }, async (req: FastifyRequest) => {
    const id = parseId(req.params);
    if (!(await keys.delete(id))) throw new NotFoundError('Provider key not found', 'provider_key_not_found');
    return ok({ id, message: 'Provider key deleted' });
  });

  // The surface default source. Lives here, not with the backend switch in
  // admin settings, because choosing `upstream` spends provider keys
  // (`keys.manage`), and it checks the provider keys and engine first.
  app.post('/admin/api/surfaces/:surface/source', { preHandler: app.requireAdmin }, async (req: FastifyRequest) => {
    const { surface } = req.params as { surface?: string };
    if (!isApiSurfaceId(surface)) throw invalid(`surface must be one of ${API_SURFACE_IDS.join(', ')}`, 'surface');
    const source = objectBody(req.body).source;
    if (!isApiSource(source)) throw invalid('source must be "emulated" or "upstream"', 'source');
    const def = API_SURFACES[surface];
    const previous = storedSource(await settings.getRaw(def.sourceFlag));
    if (source === 'upstream' && previous !== 'upstream') {
      const provider = PROVIDERS[def.provider];
      await assertFleetEngineEnabledForAdmin(ctx.db, provider.engine);
      if ((await keys.counts())[def.provider].usable === 0) {
        throw new ConflictError(
          `Store an active ${provider.label} API key before switching the ${def.label} API to the upstream source`,
          'provider_key_missing',
        );
      }
    }
    if (source !== previous) {
      await settings.set(def.sourceFlag, source);
      await recordLog(ctx, 'admin.api.surface_source', { surface, source, previous });
    }
    return ok((await listApiSurfaces(ctx.db)).find((row) => row.surface === surface));
  });
}

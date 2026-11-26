/**
 * One implementation behind the four admin gateway-key surfaces:
 * `/admin/{openai,claude,grok,kimi}/keys`. They share the `openai_api_keys`
 * table, told apart by the `engine` column (the key namespace, not who
 * answers: that is `backend_engine`), so they get one validation, one record
 * shape, one audit trail and one set of WS events.
 *
 * Each surface still registers its four routes with literal paths (route
 * discovery, the capability map and the docs checks read those), passing the
 * handlers built here.
 *
 *   GET    /admin/<surface>/keys              list, newest first
 *   POST   /admin/<surface>/keys              issue; the plaintext key is returned once
 *                                             (optional backend_engine and source pins)
 *   POST   /admin/<surface>/keys/:id/toggle   set is_active from a boolean `active`
 *   DELETE /admin/<surface>/keys/:id          delete
 *
 * Every malformed request is `400 invalid_request` with the offending `param`;
 * an id that is valid but not a key of this surface is `404 not_found`.
 */
import type { FastifyRequest } from 'fastify';
import type { RouteContext } from '../../index.js';
import type { OpenaiApiKey } from '../../../db/schema.js';
import { ApiError, NotFoundError } from '../../../http/errors.js';
import { parseKeyBackend, parseKeySource } from '../../../services/api-key-routing.js';
import { appendAuditLog } from '../../../services/audit-log.js';
import { normalizeBool } from '../../../services/config-normalizer.js';
import { OpenAiKeyService } from '../../../services/openai-keys.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINE_GROK, ENGINE_KIMI, type Engine } from '../../../util/engine.js';
import { isRfc3339, nowIso } from '../../../util/timestamp.js';
import { wsPublisher } from '../../../ws/publisher.js';

/** URL namespace → key namespace stored in `openai_api_keys.engine`. */
export const GATEWAY_KEY_SURFACES = {
  openai: ENGINE_CODEX,
  claude: ENGINE_CLAUDE,
  grok: ENGINE_GROK,
  kimi: ENGINE_KIMI,
} as const satisfies Record<string, Engine>;
export type GatewayKeySurface = keyof typeof GATEWAY_KEY_SURFACES;

/** `openai_api_keys.name` is VARCHAR(255). */
const NAME_MAX = 255;

function invalid(message: string, param?: string): ApiError {
  return new ApiError(message, { status: 400, code: 'invalid_request', type: 'invalid_request_error', param });
}

function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be a JSON object');
  return body as Record<string, unknown>;
}

function parseKeyId(params: unknown): number {
  const raw = (params as { id?: unknown } | undefined)?.id;
  const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw invalid('Invalid key id', 'id');
  return id;
}

function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw invalid('name is required', 'name');
  if (name.length > NAME_MAX) throw invalid(`name must be at most ${NAME_MAX} characters`, 'name');
  return name;
}

/** Absent, null or blank means "never expires"; anything else must be RFC3339. */
function parseExpiresAt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid('expires_at must be an RFC3339 timestamp or null', 'expires_at');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!isRfc3339(trimmed)) throw invalid('expires_at must be an RFC3339 timestamp or null', 'expires_at');
  return trimmed;
}

/** Wire record shared by every surface's list and create responses. */
export function toAdminApiKey(
  row: Pick<
    OpenaiApiKey,
    | 'id'
    | 'name'
    | 'keyPrefix'
    | 'adminUserId'
    | 'isActive'
    | 'useCount'
    | 'lastUsedAt'
    | 'expiresAt'
    | 'engine'
    | 'createdAt'
    | 'updatedAt'
  > & { backendEngine?: string | null; source?: string | null },
) {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.keyPrefix,
    admin_user_id: row.adminUserId ?? null,
    is_active: row.isActive === 1,
    use_count: Number(row.useCount),
    last_used_at: row.lastUsedAt ?? null,
    expires_at: row.expiresAt ?? null,
    engine: row.engine,
    backend_engine: row.backendEngine ?? null,
    source: row.source ?? null,
    created_at: row.createdAt ?? null,
    updated_at: row.updatedAt ?? null,
  };
}

export function gatewayKeyHandlers(ctx: Pick<RouteContext, 'db' | 'keyring'>, surface: GatewayKeySurface) {
  const engine = GATEWAY_KEY_SURFACES[surface];
  const keys = new OpenAiKeyService({ db: ctx.db, keyring: ctx.keyring });

  async function audit(action: 'create' | 'toggle' | 'delete', details: Record<string, unknown>): Promise<void> {
    try {
      await appendAuditLog(ctx.db, {
        action: `${surface}.key.${action}`,
        engine,
        details: JSON.stringify(details),
        createdAt: nowIso(),
      });
    } catch {
      /* best-effort: the key change itself has already been applied */
    }
  }

  return {
    async list() {
      return (await keys.listByEngine(engine)).map(toAdminApiKey);
    },

    async create(req: FastifyRequest) {
      const body = objectBody(req.body);
      const name = parseName(body.name);
      const expiresAt = parseExpiresAt(body.expires_at);
      const backendEngine = await parseKeyBackend(ctx.db, body.backend_engine);
      const source = parseKeySource(body.source);
      const adminUserId = req.admin?.user.id ?? null;
      const issued = await keys.issue({ name, engine, adminUserId, expiresAt, backendEngine, source });
      await audit('create', { key_id: issued.record.id, name, admin_user_id: adminUserId });
      wsPublisher.publish('apikey.created', { id: issued.record.id, engine, name });
      return { key: issued.key, record: toAdminApiKey(issued.record) };
    },

    async toggle(req: FastifyRequest) {
      const id = parseKeyId(req.params);
      const active = normalizeBool(objectBody(req.body).active);
      if (active === null) throw invalid('active must be a boolean', 'active');
      if (!(await keys.setActive(id, active, engine))) throw new NotFoundError('Key not found');
      await audit('toggle', { key_id: id, active });
      wsPublisher.publish('apikey.toggled', { id, engine, active });
      return { id, active, message: active ? 'Key enabled' : 'Key disabled' };
    },

    async remove(req: FastifyRequest) {
      const id = parseKeyId(req.params);
      if (!(await keys.delete(id, engine))) throw new NotFoundError('Key not found');
      await audit('delete', { key_id: id });
      wsPublisher.publish('apikey.deleted', { id, engine });
      return { id, message: 'Key deleted' };
    },
  };
}

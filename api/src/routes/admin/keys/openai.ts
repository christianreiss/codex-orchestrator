import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ApiError } from '../../../http/errors.js';
import { OpenAiKeyService } from '../../../services/openai-keys.js';
import { ENGINE_CODEX } from '../../../util/engine.js';
import { wsPublisher } from '../../../ws/publisher.js';
import type { OpenaiApiKey } from '../../../db/schema.js';

/**
 * Admin CRUD for the codex-scoped OpenAI bearer keys. The list endpoint is
 * filtered to `engine = codex` so claude-scoped keys (issued by the
 * anthropic-compat worktree) don't leak into the OpenAI admin UI.
 *
 * Every mutation emits a `apikey.{created,toggled,deleted}` event on the WS
 * publisher; the SvelteKit admin invalidates its key list cache in response.
 */
const createSchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  rate_limit_rpm: z.number().int().positive().optional(),
  expires_at: z
    .string()
    .trim()
    .min(1)
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : v ?? null)),
});

const toggleSchema = z.object({
  active: z.coerce.boolean().optional(),
});

export async function registerAdminOpenAiKeyRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const keys = new OpenAiKeyService({ db: ctx.db, keyring: ctx.keyring });

  app.get('/admin/openai/keys', {
    preHandler: [app.requireAdmin],
    handler: async () => {
      const rows = await keys.listByEngine(ENGINE_CODEX);
      return rows.map(toAdminApiKey);
    },
  });

  app.post('/admin/openai/keys', {
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const parsed = createSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ApiError(first?.message ?? 'Invalid request body', {
          status: 400,
          code: 'invalid_request',
          type: 'invalid_request_error',
          param: first?.path?.join('.'),
        });
      }
      const issued = await keys.issue({
        name: parsed.data.name,
        adminUserId: req.admin?.user.id ?? null,
        rateLimitRpm: parsed.data.rate_limit_rpm ?? 60,
        expiresAt: parsed.data.expires_at ?? null,
        engine: ENGINE_CODEX,
      });
      wsPublisher.publish('apikey.created', {
        id: issued.record.id,
        engine: ENGINE_CODEX,
        name: issued.record.name,
      });
      // Return the same shape the legacy PHP API used so the admin UI doesn't
      // need adjustment: { key, record }. The standard envelope wraps it.
      return { key: issued.key, record: toAdminApiKey(issued.record) };
    },
  });

  app.post('/admin/openai/keys/:id/toggle', {
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId(req.params);
      const parsed = toggleSchema.safeParse(req.body ?? {});
      const active = parsed.success ? Boolean(parsed.data.active) : false;
      const updated = await keys.setActive(id, active, ENGINE_CODEX);
      if (!updated) {
        throw new ApiError('Key not found', {
          status: 404,
          code: 'not_found',
          type: 'not_found_error',
        });
      }
      wsPublisher.publish('apikey.toggled', { id, engine: ENGINE_CODEX, active });
      return { id, active, message: active ? 'Key enabled' : 'Key disabled' };
    },
  });

  app.delete('/admin/openai/keys/:id', {
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId(req.params);
      const removed = await keys.delete(id, ENGINE_CODEX);
      if (!removed) {
        throw new ApiError('Key not found', {
          status: 404,
          code: 'not_found',
          type: 'not_found_error',
        });
      }
      wsPublisher.publish('apikey.deleted', { id, engine: ENGINE_CODEX });
      return { id, message: 'Key deleted' };
    },
  });
}

export function toAdminApiKey(
  row: Pick<
    OpenaiApiKey,
    | 'id'
    | 'name'
    | 'keyPrefix'
    | 'adminUserId'
    | 'rateLimitRpm'
    | 'isActive'
    | 'useCount'
    | 'lastUsedAt'
    | 'expiresAt'
    | 'engine'
    | 'createdAt'
    | 'updatedAt'
  >,
) {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.keyPrefix,
    admin_user_id: row.adminUserId ?? null,
    rate_limit_rpm: row.rateLimitRpm,
    // Boolean, not the raw tinyint: `/admin/claude/keys` serves the same table
    // through `toRecord` in services/claude-keys.ts and emits a boolean, and
    // the two routes are one admin surface. See admin-key-payload-parity.test.
    is_active: row.isActive === 1,
    use_count: row.useCount,
    last_used_at: row.lastUsedAt ?? null,
    expires_at: row.expiresAt ?? null,
    engine: row.engine,
    created_at: row.createdAt ?? null,
    updated_at: row.updatedAt ?? null,
  };
}

function parseId(params: unknown): number {
  if (!params || typeof params !== 'object') {
    throw new ApiError('Missing id parameter', {
      status: 400,
      code: 'invalid_request',
      type: 'invalid_request_error',
      param: 'id',
    });
  }
  const raw = (params as Record<string, unknown>).id;
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError('Invalid id parameter', {
      status: 400,
      code: 'invalid_request',
      type: 'invalid_request_error',
      param: 'id',
    });
  }
  return n;
}

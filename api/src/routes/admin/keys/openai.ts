import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ApiError } from '../../../http/errors.js';
import { OpenAiKeyService } from '../../../services/openai-keys.js';
import { ENGINE_CODEX } from '../../../util/engine.js';
import { wsPublisher } from '../../../ws/publisher.js';

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
      return rows;
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
      return { key: issued.key, record: issued.record };
    },
  });

  app.post('/admin/openai/keys/:id/toggle', {
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId(req.params);
      const parsed = toggleSchema.safeParse(req.body ?? {});
      const active = parsed.success ? Boolean(parsed.data.active) : false;
      await keys.setActive(id, active);
      wsPublisher.publish('apikey.toggled', { id, engine: ENGINE_CODEX, active });
      return { id, active, message: active ? 'Key enabled' : 'Key disabled' };
    },
  });

  app.delete('/admin/openai/keys/:id', {
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const id = parseId(req.params);
      await keys.delete(id);
      wsPublisher.publish('apikey.deleted', { id, engine: ENGINE_CODEX });
      return { id, message: 'Key deleted' };
    },
  });
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

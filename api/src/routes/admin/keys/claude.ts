/**
 * Admin Claude API key management. Mirrors src/Http/Controllers/AdminClaudeKeyController.php.
 *
 *   GET    /admin/claude/keys                  — list (filtered to engine='claude')
 *   POST   /admin/claude/keys                  — issue (returns the plaintext key once)
 *   POST   /admin/claude/keys/:id/toggle       — set is_active
 *   DELETE /admin/claude/keys/:id              — remove
 *
 * Auth: requireAdmin from auth-admin plugin.
 * Side-effects: log row + ws event (`apikey.created` / `apikey.toggled` /
 * `apikey.deleted`) on each mutation.
 */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../index.js';
import { ApiError } from '../../../http/errors.js';
import { createClaudeKeysService } from '../../../services/claude-keys.js';
import { wsPublisher } from '../../../ws/publisher.js';
import { logs } from '../../../db/schema.js';
import { nowIso } from '../../../util/timestamp.js';

export async function registerAdminClaudeKeyRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const service = createClaudeKeysService(ctx.db, ctx.keyring);

  async function writeLog(action: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await ctx.db.insert(logs).values({
        action,
        details: JSON.stringify(payload),
        createdAt: nowIso(),
        engine: 'claude',
      });
    } catch {
      /* logging is best-effort */
    }
  }

  app.route({
    method: 'GET',
    url: '/admin/claude/keys',
    preHandler: [app.requireAdmin],
    handler: async () => {
      return service.list();
    },
  });

  app.route({
    method: 'POST',
    url: '/admin/claude/keys',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        throw new ApiError('name is required', {
          status: 400,
          code: 'missing_name',
          type: 'invalid_request_error',
          param: 'name',
        });
      }
      const expiresAt = typeof body.expires_at === 'string' ? body.expires_at.trim() : null;
      const adminUserId = req.admin?.user.id ?? null;

      const issued = await service.create({
        name,
        adminUserId,
        expiresAt: expiresAt && expiresAt !== '' ? expiresAt : null,
      });

      await writeLog('claude.key.create', {
        key_id: issued.record.id,
        name,
        admin_user_id: adminUserId,
      });
      wsPublisher.publish('apikey.created', {
        id: issued.record.id,
        engine: 'claude',
        name,
      });

      return { key: issued.key, record: issued.record };
    },
  });

  app.route({
    method: 'POST',
    url: '/admin/claude/keys/:id/toggle',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const params = req.params as { id: string };
      const id = Number.parseInt(params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        throw new ApiError('Invalid key id', {
          status: 400,
          code: 'invalid_id',
          type: 'invalid_request_error',
          param: 'id',
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const active = Boolean(body.active);
      const updated = await service.setActive(id, active);
      if (!updated) {
        throw new ApiError('Key not found', {
          status: 404,
          code: 'not_found',
          type: 'not_found_error',
        });
      }
      await writeLog(active ? 'claude.key.enable' : 'claude.key.disable', { key_id: id });
      wsPublisher.publish('apikey.toggled', {
        id,
        engine: 'claude',
        active,
      });
      return { message: active ? 'Key enabled' : 'Key disabled' };
    },
  });

  app.route({
    method: 'DELETE',
    url: '/admin/claude/keys/:id',
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const params = req.params as { id: string };
      const id = Number.parseInt(params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        throw new ApiError('Invalid key id', {
          status: 400,
          code: 'invalid_id',
          type: 'invalid_request_error',
          param: 'id',
        });
      }
      const removed = await service.delete(id);
      if (!removed) {
        throw new ApiError('Key not found', {
          status: 404,
          code: 'not_found',
          type: 'not_found_error',
        });
      }
      await writeLog('claude.key.delete', { key_id: id });
      wsPublisher.publish('apikey.deleted', { id, engine: 'claude' });
      return { message: 'Key deleted' };
    },
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContext } from '../../index.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../../../http/errors.js';
import { ROLE_ADMIN, ROLE_OWNER } from '../../../services/admin-auth.js';
import { AdminMemoriesService, MEMORY_SCOPES, type MemoryScope } from '../../../services/admin-memories.js';

function scopeFrom(value: unknown): MemoryScope {
  if (typeof value !== 'string' || !(MEMORY_SCOPES as readonly string[]).includes(value)) {
    throw new ValidationError('scope must be host, project, or shared', { param: 'scope' });
  }
  return value as MemoryScope;
}

function recordIdFrom(value: unknown): number {
  const id = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new ValidationError('recordId must be a positive integer', { param: 'recordId' });
  return id;
}

function canMutate(req: FastifyRequest): boolean {
  const role = req.admin?.user.accessLevel;
  return role === ROLE_OWNER || role === ROLE_ADMIN;
}

function setMemoryEtag(reply: FastifyReply, memory: { etag: string }): void {
  reply.header('ETag', `"${memory.etag}"`);
}

export async function registerAdminMemoriesRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const memories = new AdminMemoriesService(ctx.db);
  const requireMutationRole = async (req: FastifyRequest): Promise<void> => {
    if (!req.admin) throw new UnauthorizedError('Admin session required', 'admin_required');
    if (!canMutate(req)) throw new ForbiddenError('Insufficient access level', 'admin_role_required');
  };

  app.get('/admin/memories/graph', { preHandler: app.requireAdmin }, async (req) => {
    return memories.graph((req.query ?? {}) as Record<string, unknown>, canMutate(req));
  });

  app.get('/admin/memories/audit', { preHandler: app.requireAdmin }, async (req) => {
    return memories.audit((req.query ?? {}) as Record<string, unknown>);
  });

  app.get('/admin/memories/:scope/:recordId', { preHandler: app.requireAdmin }, async (req, reply) => {
    const params = req.params as { scope?: unknown; recordId?: unknown };
    const memory = await memories.detail(
      scopeFrom(params.scope),
      recordIdFrom(params.recordId),
      canMutate(req),
    );
    setMemoryEtag(reply, memory);
    return { status: 'ok', memory };
  });

  app.post(
    '/admin/memories/shared/:recordId/append',
    { preHandler: [app.requireAdmin, requireMutationRole] },
    async (req, reply) => {
      const params = req.params as { recordId?: unknown };
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== 'content') {
        throw new ValidationError('append accepts content only', { param: 'body' });
      }
      const actorId = req.admin?.user.id;
      if (!actorId) throw new UnauthorizedError('Admin session required', 'admin_required');
      const result = await memories.appendShared(recordIdFrom(params.recordId), body['content'], actorId);
      setMemoryEtag(reply, result.memory);
      return result;
    },
  );

  app.post(
    '/admin/memories/:scope',
    { preHandler: [app.requireAdmin, requireMutationRole] },
    async (req, reply) => {
      const params = req.params as { scope?: unknown };
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const actorId = req.admin?.user.id;
      if (!actorId) throw new UnauthorizedError('Admin session required', 'admin_required');
      const result = await memories.create(scopeFrom(params.scope), body, actorId);
      setMemoryEtag(reply, result.memory);
      reply.code(201);
      return result;
    },
  );

  app.patch(
    '/admin/memories/:scope/:recordId',
    { preHandler: [app.requireAdmin, requireMutationRole] },
    async (req, reply) => {
      const params = req.params as { scope?: unknown; recordId?: unknown };
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? { ...(req.body as Record<string, unknown>) }
          : {};
      if (
        !Object.prototype.hasOwnProperty.call(body, 'expected_etag') &&
        typeof req.headers['if-match'] === 'string'
      ) {
        body['expected_etag'] = req.headers['if-match'];
      }
      const actorId = req.admin?.user.id;
      if (!actorId) throw new UnauthorizedError('Admin session required', 'admin_required');
      const result = await memories.update(
        scopeFrom(params.scope),
        recordIdFrom(params.recordId),
        body,
        actorId,
      );
      setMemoryEtag(reply, result.memory);
      return result;
    },
  );

  app.delete(
    '/admin/memories/:scope/:recordId',
    { preHandler: [app.requireAdmin, requireMutationRole] },
    async (req) => {
      const params = req.params as { scope?: unknown; recordId?: unknown };
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const query = (req.query ?? {}) as Record<string, unknown>;
      const expected = body['expected_etag'] ?? query['expected_etag'] ?? req.headers['if-match'];
      const actorId = req.admin?.user.id;
      if (!actorId) throw new UnauthorizedError('Admin session required', 'admin_required');
      return memories.remove(scopeFrom(params.scope), recordIdFrom(params.recordId), expected, actorId);
    },
  );
}

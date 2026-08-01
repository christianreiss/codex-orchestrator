import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ok } from '../../../http/reply.js';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../../../http/errors.js';
import { ROLE_ADMIN, ROLE_OWNER, createAdminAuthService } from '../../../services/admin-auth.js';
import { createAdminEventsService } from '../../../services/admin-events.js';
import { createAdminUsersService } from '../../../services/admin-users.js';
import { adminSpaHtmlPreHandler } from '../pages/static.js';

/**
 * `/admin/users/*`. Every route is admin-authenticated; the index endpoint
 * additionally allows the first request through unauthenticated when no users
 * exist (so the bootstrap flow can create the first admin).
 */
export async function registerAdminUsersRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const adminSpa = adminSpaHtmlPreHandler(ctx);
  const events = createAdminEventsService(ctx.db);
  const auth = createAdminAuthService(ctx.db, ctx.env);
  const users = createAdminUsersService(ctx.db, auth, events);

  // Allow the very first user (bootstrap) to be created without a session.
  // Once any admin exists, fall through to the standard session guard.
  const requireAdminOrBootstrap = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const total = await auth.countUsers();
    if (total === 0) return;
    // Reuse the foundation guard. It throws on failure; otherwise it mutates
    // req.admin and resolves. The `done` arg is ignored because the handler
    // is `async`.
    await (app.requireAdmin as unknown as (
      req: FastifyRequest,
      reply: FastifyReply,
      done: (err?: Error) => void,
    ) => Promise<void>)(req, reply, () => undefined);
  };

  // Mutating user management (create/update/delete/wipe other admin
  // accounts) is restricted to owner/admin accounts. Every other access
  // level (viewer, fleet_operator, trusted_user, user) may still read the
  // roster via GET, but must not be able to manage accounts, including its
  // own. When `req.admin` is unset (the bootstrap path above), there is
  // nothing to check yet — the service layer already requires the first
  // user to be an owner/admin.
  const requireUserManagementRole = async (req: FastifyRequest): Promise<void> => {
    const level = req.admin?.user.accessLevel;
    if (level !== undefined && level !== ROLE_OWNER && level !== ROLE_ADMIN) {
      throw new ForbiddenError('Insufficient access level', 'admin_role_required');
    }
  };

  // -----------------------------------------------------------------------
  // GET /admin/users
  // -----------------------------------------------------------------------
  app.get('/admin/users', { preHandler: [adminSpa, app.requireAdmin] }, async () => {
    return ok({ users: await users.list() });
  });

  // -----------------------------------------------------------------------
  // POST /admin/users
  // -----------------------------------------------------------------------
  const createSchema = z.object({
    name: z.string(),
    username: z.string(),
    email: z.string(),
    password: z.string(),
    access_level: z.string(),
    active: z.union([z.boolean(), z.string(), z.number()]).optional(),
  });
  app.post(
    '/admin/users',
    { preHandler: [requireAdminOrBootstrap, requireUserManagementRole] },
    async (req: FastifyRequest) => {
      const body = createSchema.parse((req.body ?? {}) as Record<string, unknown>);
      const input = {
        name: body.name,
        username: body.username,
        email: body.email,
        password: body.password,
        access_level: body.access_level,
        active:
          typeof body.active === 'boolean' ? body.active : body.active === undefined ? true : Boolean(body.active),
      };
      const user = req.admin
        ? await users.create(input)
        : await users.createFirstOwner(input);
      return ok({ user });
    },
  );

  // -----------------------------------------------------------------------
  // POST /admin/users/wipe — must precede the dynamic /:id route
  // -----------------------------------------------------------------------
  app.post(
    '/admin/users/wipe',
    { preHandler: [app.requireAdmin, requireUserManagementRole] },
    async (req: FastifyRequest) => {
      const adminCtx = req.admin;
      if (!adminCtx) throw new UnauthorizedError();
      const body = (req.body ?? {}) as { confirm?: unknown };
      if (body.confirm !== 'WIPE') {
        throw new ValidationError('Confirmation required', { param: 'confirm' });
      }
      const result = await users.wipe(adminCtx.user.id);
      return ok({ removed: result.removed });
    },
  );

  // -----------------------------------------------------------------------
  // POST /admin/users/:id
  // -----------------------------------------------------------------------
  const updateSchema = z
    .object({
      name: z.string().optional(),
      username: z.string().optional(),
      email: z.string().optional(),
      password: z.string().optional(),
      access_level: z.string().optional(),
      active: z.union([z.boolean(), z.string(), z.number()]).optional(),
    })
    .strict();
  app.post(
    '/admin/users/:id',
    { preHandler: [app.requireAdmin, requireUserManagementRole] },
    async (req: FastifyRequest) => {
      const params = (req.params ?? {}) as { id?: string };
      const id = Number(params.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new NotFoundError('User not found', 'user_not_found');
      }
      const body = updateSchema.parse((req.body ?? {}) as Record<string, unknown>);
      const normalized: Parameters<typeof users.update>[1] = {
        ...body,
        active:
          body.active === undefined
            ? undefined
            : typeof body.active === 'boolean'
              ? body.active
              : Boolean(body.active),
      };
      const user = await users.update(id, normalized);
      return ok({ user });
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /admin/users/:id
  // -----------------------------------------------------------------------
  app.delete(
    '/admin/users/:id',
    { preHandler: [app.requireAdmin, requireUserManagementRole] },
    async (req: FastifyRequest) => {
      const params = (req.params ?? {}) as { id?: string };
      const id = Number(params.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new NotFoundError('User not found', 'user_not_found');
      }
      await users.remove(id);
      return ok({});
    },
  );
}

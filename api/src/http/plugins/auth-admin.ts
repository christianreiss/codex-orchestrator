import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { eq, and, gt } from 'drizzle-orm';
import { adminSessions, adminUsers } from '../../db/schema.js';
import type { AdminUser, AdminSession } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import { sha256 } from '../../security/hash.js';
import type { Env } from '../../env.js';
import { UnauthorizedError, ForbiddenError } from '../errors.js';

export interface AdminContext {
  user: AdminUser;
  session: AdminSession;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminContext;
  }
  interface FastifyInstance {
    requireAdmin: preHandlerHookHandler;
    resolveAdmin(req: FastifyRequest): Promise<AdminContext | null>;
  }
}

export function makeAuthAdminPlugin(db: Database, env: Env) {
  const cookieName = env.ADMIN_SESSION_COOKIE;

  return fp(
    async function authAdminPlugin(app: FastifyInstance) {
      app.decorate('resolveAdmin', async (req: FastifyRequest): Promise<AdminContext | null> => {
        const raw = req.cookies?.[cookieName];
        if (!raw) return null;
        const tokenHash = sha256(raw);
        const nowIso = new Date().toISOString();
        const rows = await db
          .select({
            session: adminSessions,
            user: adminUsers,
          })
          .from(adminSessions)
          .innerJoin(adminUsers, eq(adminSessions.userId, adminUsers.id))
          .where(and(eq(adminSessions.tokenHash, tokenHash), gt(adminSessions.expiresAt, nowIso)))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        if (!row.user.active) return null;
        // Best-effort: touch lastSeenAt
        try {
          await db
            .update(adminSessions)
            .set({ lastSeenAt: nowIso })
            .where(eq(adminSessions.id, row.session.id));
        } catch {
          /* non-fatal */
        }
        return { user: row.user, session: row.session };
      });

      app.decorate('requireAdmin', async function requireAdmin(req: FastifyRequest) {
        const ctx = await app.resolveAdmin(req);
        if (!ctx) throw new UnauthorizedError('Admin session required', 'admin_required');
        if (!ctx.user.active) throw new ForbiddenError('Account disabled', 'admin_disabled');
        req.admin = ctx;
      });
    },
    { name: 'auth-admin' },
  );
}

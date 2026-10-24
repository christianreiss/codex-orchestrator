import {installOwnerResponseBoundary} from './owner-response.js';
import { mutateOwnerState, ownerRuntimeFor, withOwnerRequestScope, setOwnerRequestPrincipal } from '../../control-plane/state/runtime.js';
import { resolveOwnerAdmin } from '../../control-plane/state/admission.js';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { eq, and, gt } from 'drizzle-orm';
import { adminSessions, adminUsers } from '../../db/schema.js';
import type { AdminUser, AdminSession } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import { sha256 } from '../../security/hash.js';
import type { Env } from '../../env.js';
import { UnauthorizedError, ForbiddenError } from '../errors.js';
import { adminSessionTtlSeconds } from '../../services/admin-auth.js';
import { isoOffsetSeconds } from '../../util/timestamp.js';

export interface AdminContext {
  user: Omit<AdminUser, 'passwordHash'> & { passwordHash?: string };
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
      app.addHook('onRequest', (_req, _reply, done) => withOwnerRequestScope(done));
      const runtime=ownerRuntimeFor(db);if(runtime)installOwnerResponseBoundary(app,runtime);
      app.decorate('resolveAdmin', async (req: FastifyRequest): Promise<AdminContext | null> => {
        const raw = req.cookies?.[cookieName];
        if (!raw) return null;
        const tokenHash = sha256(raw);
        const owner = ownerRuntimeFor(db);
        if (owner) {
          const current = resolveOwnerAdmin(db, tokenHash);
          if (!current) return null;
          setOwnerRequestPrincipal({ principal: `admin:${current.user.id}`, revalidate(snapshot) {
            const session = snapshot.adminSessions.by('tokenHash', tokenHash)[0];
            const user = session ? snapshot.table('adminUsers').get(session.userId) : undefined;
            if (!session || Date.parse(session.expiresAt) <= Date.now() || !user?.active || user.id !== current.user.id || user.accessLevel !== current.user.accessLevel) throw new UnauthorizedError('Admin authority changed', 'admin_required');
          } });
          const ttlMs = adminSessionTtlSeconds(env) * 1000;
          // Renew only when half the durable lifetime remains, on real use.
          // No heartbeat UPDATE and no loss of an acknowledged renewal on crash.
          if (Date.parse(current.session.expiresAt) - Date.now() <= ttlMs / 2) {
            await mutateOwnerState(owner, { kind: 'admin.session.renew', payload: { tokenHash }, prepare(ctx) {
              const session = ctx.draft.table('adminSessions').by('tokenHash', tokenHash)[0];
              const user = session ? ctx.draft.table('adminUsers').get(session.userId) : undefined;
              const now = new Date();
              if (!session || !user?.active || Date.parse(session.expiresAt) <= now.getTime()) return false;
              if (Date.parse(session.expiresAt) - now.getTime() > ttlMs / 2) return true;
              const patch = { lastSeenAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
              ctx.draft.upsert('adminSessions', { ...session, ...patch });
              ctx.write(async tx => tx.update(adminSessions).set(patch).where(eq(adminSessions.id, session.id)));
              return true;
            } });
          }
          return resolveOwnerAdmin(db, tokenHash);
        }
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
        // Best-effort: roll session expiry (keeps active sessions alive)
        try {
          await db
            .update(adminSessions)
            .set({ lastSeenAt: nowIso, expiresAt: isoOffsetSeconds(adminSessionTtlSeconds(env)) })
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

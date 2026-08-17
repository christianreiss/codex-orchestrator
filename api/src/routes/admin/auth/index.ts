import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ok } from '../../../http/reply.js';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../../http/errors.js';
import { createAdminAuthService } from '../../../services/admin-auth.js';
import { createAdminEventsService } from '../../../services/admin-events.js';
import { createAdminPasskeyService } from '../../../services/admin-passkey.js';
import { createAdminPasswordService } from '../../../services/admin-password.js';
import { createMailer } from '../../../services/mailer.js';
import { capabilitiesForRole } from '../../../security/capabilities.js';

/**
 * `/admin/auth/*` and `/admin/passkeys/*`. The status probe is public; login,
 * login/method, password/request, password/reset, and passkey/login/* are
 * public too because the user is by definition not yet authenticated. Every
 * other route guards on `app.requireAdmin`.
 */
export async function registerAdminAuthRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { db, env } = ctx;
  const events = createAdminEventsService(db);
  const auth = createAdminAuthService(db, env);
  const passkeys = createAdminPasskeyService(db, env, events);
  const mailer = createMailer(env, app.log);
  const passwords = createAdminPasswordService(db, env, auth, events, mailer);

  const clientIp = (req: FastifyRequest): string | null =>
    (req as FastifyRequest & { clientIp?: string }).clientIp ?? req.ip ?? null;
  const userAgent = (req: FastifyRequest): string | null => {
    const h = req.headers['user-agent'];
    return typeof h === 'string' && h.length > 0 ? h : null;
  };

  // -----------------------------------------------------------------------
  // GET /admin/auth/status
  // -----------------------------------------------------------------------
  app.get('/admin/auth/status', async (req: FastifyRequest) => {
    const token = auth.readTokenFromRequest(req);
    const session = await auth.resolveSession(token);
    const [hasUsers, adminCount, anyPasskey] = await Promise.all([
      auth.countUsers().then((n) => n > 0),
      auth.countAdmins(true),
      auth.anyPasskeyRegistered(),
    ]);
    const userPayload = session ? auth.sanitizeUser(session.user) : null;
    let passkeysRegistered = 0;
    if (session) {
      passkeysRegistered = (await passkeys.listForUser(session.user.id)).length;
    }
    return ok({
      has_users: hasUsers,
      admin_count: adminCount,
      enforced: adminCount > 0,
      authenticated: Boolean(session),
      user: userPayload,
      // The caller's row of the role→capability matrix. The console uses it to
      // disable the controls a 403 would meet, so an operator sees what they
      // may do before they try it — and it is the console's *only* source for
      // that, so a stale UI cannot invent a permission. The server re-checks
      // every request regardless; this is presentation, never authority.
      capabilities: session ? [...capabilitiesForRole(session.user.accessLevel)] : [],
      passkeys_registered: passkeysRegistered,
      passkey_login_available: anyPasskey,
    });
  });

  // -----------------------------------------------------------------------
  // POST /admin/auth/login
  // -----------------------------------------------------------------------
  const loginSchema = z.object({
    username: z.string(),
    password: z.string(),
  });
  app.post('/admin/auth/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = loginSchema.parse((req.body ?? {}) as Record<string, unknown>);
    const result = await auth.login(body.username, body.password, clientIp(req), userAgent(req));
    auth.applySessionCookie(reply, result.token, result.expires_at);
    return ok({ user: result.user, expires_at: result.expires_at });
  });

  // -----------------------------------------------------------------------
  // POST /admin/auth/login/method
  // -----------------------------------------------------------------------
  app.post('/admin/auth/login/method', async (req: FastifyRequest) => {
    const body = z.object({ username: z.string() }).parse((req.body ?? {}) as Record<string, unknown>);
    return ok({ method: await auth.resolveLoginMethod(body.username) });
  });

  // -----------------------------------------------------------------------
  // POST /admin/auth/logout
  // -----------------------------------------------------------------------
  app.post(
    '/admin/auth/logout',
    { preHandler: [app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = auth.readTokenFromRequest(req);
      await auth.logoutByToken(token);
      auth.clearSessionCookie(reply);
      return ok({});
    },
  );

  // -----------------------------------------------------------------------
  // POST /admin/auth/password/change
  // -----------------------------------------------------------------------
  const passwordChangeSchema = z.object({
    current_password: z.string(),
    new_password: z.string(),
    confirm_password: z.string(),
  });
  app.post(
    '/admin/auth/password/change',
    { preHandler: [app.requireAdmin] },
    async (req: FastifyRequest) => {
      const adminCtx = req.admin;
      if (!adminCtx) throw new UnauthorizedError();
      const body = passwordChangeSchema.parse((req.body ?? {}) as Record<string, unknown>);
      const token = auth.readTokenFromRequest(req);
      const user = await passwords.changePassword(
        adminCtx.user.id,
        body.current_password,
        body.new_password,
        body.confirm_password,
        token,
      );
      return ok({ user });
    },
  );

  // -----------------------------------------------------------------------
  // POST /admin/auth/password/request
  // -----------------------------------------------------------------------
  app.post('/admin/auth/password/request', async (req: FastifyRequest) => {
    const body = z.object({ username: z.string().optional(), email: z.string().optional() }).parse(
      (req.body ?? {}) as Record<string, unknown>,
    );
    const identifier = (body.username ?? body.email ?? '').trim();
    if (!identifier) {
      throw new ValidationError('Username or email is required', { param: 'username' });
    }
    const result = await passwords.requestReset(identifier);
    return ok({ delivered: result.delivered });
  });

  // -----------------------------------------------------------------------
  // POST /admin/auth/password/reset
  // -----------------------------------------------------------------------
  const passwordResetSchema = z.object({
    token: z.string(),
    new_password: z.string(),
    confirm_password: z.string(),
  });
  app.post('/admin/auth/password/reset', async (req: FastifyRequest) => {
    const body = passwordResetSchema.parse((req.body ?? {}) as Record<string, unknown>);
    const user = await passwords.applyReset(body.token, body.new_password, body.confirm_password);
    return ok({ user });
  });

  // -----------------------------------------------------------------------
  // POST /admin/auth/passkey/login/options
  // -----------------------------------------------------------------------
  app.post('/admin/auth/passkey/login/options', async (req: FastifyRequest) => {
    const body = z.object({ username: z.string().optional() }).parse((req.body ?? {}) as Record<string, unknown>);
    const options = await passkeys.beginAuthentication(body.username ?? '', req);
    return ok(options);
  });

  // -----------------------------------------------------------------------
  // POST /admin/auth/passkey/login
  // -----------------------------------------------------------------------
  app.post('/admin/auth/passkey/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = normalizePasskeyAuthenticationBody(req.body);
    const user = await passkeys.completeAuthentication(
      body as Parameters<typeof passkeys.completeAuthentication>[0],
      req,
    );
    const session = await auth.createSession(user, clientIp(req), userAgent(req), 'admin.auth.passkey.login');
    auth.applySessionCookie(reply, session.token, session.expires_at);
    return ok({ user: session.user, expires_at: session.expires_at });
  });

  // -----------------------------------------------------------------------
  // POST /admin/auth/passkey/register/options
  // -----------------------------------------------------------------------
  app.post(
    '/admin/auth/passkey/register/options',
    { preHandler: [app.requireAdmin] },
    async (req: FastifyRequest) => {
      const adminCtx = req.admin;
      if (!adminCtx) throw new UnauthorizedError();
      const options = await passkeys.beginRegistration(
        {
          id: adminCtx.user.id,
          username: adminCtx.user.username,
          name: adminCtx.user.name,
        },
        req,
      );
      return ok(options);
    },
  );

  // -----------------------------------------------------------------------
  // POST /admin/auth/passkey/register
  // -----------------------------------------------------------------------
  app.post(
    '/admin/auth/passkey/register',
    { preHandler: [app.requireAdmin] },
    async (req: FastifyRequest) => {
      const adminCtx = req.admin;
      if (!adminCtx) throw new UnauthorizedError();
      const body = normalizePasskeyRegistrationBody(req.body);
      const passkey = await passkeys.completeRegistration(
        { id: adminCtx.user.id, username: adminCtx.user.username, name: adminCtx.user.name },
        body as Parameters<typeof passkeys.completeRegistration>[1],
        req,
      );
      return ok({ passkey });
    },
  );

  // -----------------------------------------------------------------------
  // GET /admin/passkeys
  // -----------------------------------------------------------------------
  app.get(
    '/admin/passkeys',
    { preHandler: [app.requireAdmin] },
    async (req: FastifyRequest) => {
      const adminCtx = req.admin;
      if (!adminCtx) throw new UnauthorizedError();
      return ok({ passkeys: await passkeys.listForUser(adminCtx.user.id) });
    },
  );

  // -----------------------------------------------------------------------
  // POST /admin/passkeys/:id/name
  // -----------------------------------------------------------------------
  const renameSchema = z.object({ name: z.string() });
  app.post(
    '/admin/passkeys/:id/name',
    { preHandler: [app.requireAdmin] },
    async (req: FastifyRequest) => {
      const adminCtx = req.admin;
      if (!adminCtx) throw new UnauthorizedError();
      const params = (req.params ?? {}) as { id?: string };
      const id = Number(params.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new NotFoundError('Passkey not found', 'passkey_not_found');
      }
      const body = renameSchema.parse((req.body ?? {}) as Record<string, unknown>);
      await passkeys.rename(id, adminCtx.user.id, body.name);
      return ok({});
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /admin/passkeys/:id
  // -----------------------------------------------------------------------
  app.delete(
    '/admin/passkeys/:id',
    { preHandler: [app.requireAdmin] },
    async (req: FastifyRequest) => {
      const adminCtx = req.admin;
      if (!adminCtx) throw new UnauthorizedError();
      const params = (req.params ?? {}) as { id?: string };
      const id = Number(params.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new NotFoundError('Passkey not found', 'passkey_not_found');
      }
      await passkeys.deletePasskey(id, adminCtx.user.id);
      return ok({});
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && value[key].length > 0;
}

function looksLikeRegistrationCredential(value: unknown): boolean {
  if (!isRecord(value) || !hasString(value, 'id') || !hasString(value, 'rawId')) return false;
  const response = value.response;
  return (
    isRecord(response) &&
    hasString(response, 'clientDataJSON') &&
    hasString(response, 'attestationObject')
  );
}

function looksLikeAuthenticationCredential(value: unknown): boolean {
  if (!isRecord(value) || !hasString(value, 'id') || !hasString(value, 'rawId')) return false;
  const response = value.response;
  return (
    isRecord(response) &&
    hasString(response, 'clientDataJSON') &&
    hasString(response, 'authenticatorData') &&
    hasString(response, 'signature')
  );
}

export function normalizePasskeyRegistrationBody(body: unknown): { response: unknown; name?: string } {
  if (!isRecord(body)) {
    throw new ValidationError('Missing attestation response', { param: 'response' });
  }
  const name = typeof body.name === 'string' ? body.name : undefined;
  if (looksLikeRegistrationCredential(body)) {
    return { response: body, name };
  }
  if (looksLikeRegistrationCredential(body.response)) {
    return { response: body.response, name };
  }
  if (body.response) {
    return { response: body.response, name };
  }
  throw new ValidationError('Missing attestation response', { param: 'response' });
}

export function normalizePasskeyAuthenticationBody(body: unknown): { response: unknown } {
  if (!isRecord(body)) {
    throw new ValidationError('Missing assertion response', { param: 'response' });
  }
  if (looksLikeAuthenticationCredential(body)) {
    return { response: body };
  }
  if (looksLikeAuthenticationCredential(body.response)) {
    return { response: body.response };
  }
  if (body.response) {
    return { response: body.response };
  }
  throw new ValidationError('Missing assertion response', { param: 'response' });
}

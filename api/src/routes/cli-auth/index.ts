import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import { requireAgentMessagingMutationRole } from '../agent-messaging/index.js';
import { ApiError, NotFoundError, ValidationError } from '../../http/errors.js';
import { createCliAuthService } from '../../services/cli-auth.js';
import { createHostRegistrationService } from '../../services/host-registration.js';
import { createInsecureWindowService } from '../../services/insecure-window.js';

/**
 * The approval form: frontend/src/routes/cli-auth/verify/+page.svelte, built
 * under the SPA's `paths.base = '/admin'` (frontend/svelte.config.js).
 */
const VERIFY_PAGE_PATH = '/admin/cli-auth/verify';

/**
 * CLI device-code auth (`/cli/auth/*`).
 *
 *   POST /cli/auth/start          → CLI wrapper begins login
 *   POST /cli/auth/poll/:id       → CLI wrapper polls until approved/denied
 *   GET  /cli/auth/verify         → 302 to the admin-facing approval page
 *   POST /cli/auth/lookup         → admin: confirm a pending request
 *   POST /cli/auth/approve        → admin: approve and register the host
 *   POST /cli/auth/deny           → admin: deny the request
 *
 * /start + /poll are open to wrappers; lookup/approve/
 * deny require an admin session. /verify is the URL handed to the wrapper, so
 * it stays where it is and redirects the operator's browser to the SPA page
 * that renders the approval form.
 *
 * KILL-SWITCH: /cli/auth/start is exempt from the API kill switch (parity
 * with PHP). The kill switch is checked elsewhere; this route deliberately
 * never inspects it.
 */
export async function registerCliAuthRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const insecure = createInsecureWindowService({ db: ctx.db, env: ctx.env });
  const registration = createHostRegistrationService({ db: ctx.db, keyring: ctx.keyring, insecure });
  const cli = createCliAuthService({ db: ctx.db, keyring: ctx.keyring, registration });

  app.post('/cli/auth/start', async (req) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const fqdn = typeof body.fqdn === 'string' ? body.fqdn : '';
    const secure = body.secure === undefined ? true : Boolean(body.secure);
    const ua = req.headers['user-agent'];
    const userAgent = typeof ua === 'string' ? ua : Array.isArray(ua) ? ua[0] ?? null : null;
    const data = await cli.start({ fqdn, secure, ip: req.clientIp || null, userAgent });
    const baseUrl = (ctx.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
    return { ...data, verify_url: baseUrl ? `${baseUrl}/cli/auth/verify` : '/cli/auth/verify' };
  });

  app.post<{ Params: { id: string } }>('/cli/auth/poll/:id', async (req) => {
    const id = req.params.id;
    if (!/^[a-f0-9]{64}$/.test(id)) throw new NotFoundError('Request not found');
    const data = await cli.poll(id);
    if (data.status === 'not_found') throw new NotFoundError('Request not found');
    if (data.status === 'approved') {
      const baseUrl = (ctx.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
      return { ...data, base_url: baseUrl || null };
    }
    return data;
  });

  app.get('/cli/auth/verify', async (req, reply) => {
    // Optional: when an admin session is configured, gate this route. The
    // foundation already exposes app.resolveAdmin so we use it best-effort.
    // The legacy PHP redirected to /admin/login when unauthenticated; we
    // surface a 401 instead since the front-end can intercept it.
    try {
      const ctx2 = await app.resolveAdmin(req);
      if (!ctx2 && (ctx.env.ADMIN_ACCESS_MODE !== 'open')) {
        // Not enforced in tests; return 401 so the browser path knows to log in.
        throw new ApiError('Admin session required', { status: 401, code: 'admin_required' });
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
    }
    const baseUrl = (ctx.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
    return reply.redirect(`${baseUrl}${VERIFY_PAGE_PATH}`, 302);
  });

  app.post('/cli/auth/lookup', {
    preHandler: app.requireAdmin,
    handler: async (req) => {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const userCode = typeof body.user_code === 'string' ? body.user_code : '';
      if (!userCode.trim()) throw new ValidationError('user_code is required', { param: 'user_code' });
      const data = await cli.lookup(userCode);
      if (!data) throw new NotFoundError('Login request not found or expired');
      return data;
    },
  });

  app.post('/cli/auth/approve', {
    preHandler: [app.requireAdmin, requireAgentMessagingMutationRole],
    handler: async (req) => {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const userCode = typeof body.user_code === 'string' ? body.user_code : '';
      if (!userCode.trim()) throw new ValidationError('user_code is required', { param: 'user_code' });
      const admin = req.admin;
      return cli.approve(userCode, admin?.user.id ?? 0, admin?.user.username ?? null);
    },
  });

  app.post('/cli/auth/deny', {
    preHandler: app.requireAdmin,
    handler: async (req) => {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const userCode = typeof body.user_code === 'string' ? body.user_code : '';
      if (!userCode.trim()) throw new ValidationError('user_code is required', { param: 'user_code' });
      const r = await cli.deny(userCode);
      return { message: 'Login request denied', ...r };
    },
  });
}

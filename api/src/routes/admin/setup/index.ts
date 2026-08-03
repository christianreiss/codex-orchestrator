import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ok } from '../../../http/reply.js';
import { createAdminAuthService } from '../../../services/admin-auth.js';
import { createAdminEventsService } from '../../../services/admin-events.js';
import { createAdminUsersService } from '../../../services/admin-users.js';
import { createSetupStatusService } from '../../../services/setup-status.js';
import { SETUP_WIZARD_STEPS, createSetupWizardService } from '../../../services/setup-wizard.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../../../util/engine.js';

export async function registerAdminSetupRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const auth = createAdminAuthService(ctx.db, ctx.env);
  const users = createAdminUsersService(ctx.db, auth, createAdminEventsService(ctx.db));
  const setup = createSetupStatusService(ctx.db, ctx.env, ctx.keyring);
  const wizard = createSetupWizardService(ctx.db);

  // Public only while the installation is unclaimed. Naming app.requireAdmin
  // in this alias also keeps the repo-wide admin-route guard audit honest.
  const requireAdminAfterSetup = async (req: FastifyRequest): Promise<void> => {
    if ((await auth.countUsers()) === 0) return;
    await (app.requireAdmin as unknown as (
      request: FastifyRequest,
      reply: unknown,
      done: (error?: Error) => void,
    ) => Promise<void>)(req, undefined, () => undefined);
  };

  app.get('/admin/setup/status', { preHandler: [requireAdminAfterSetup] }, async (req: FastifyRequest) => {
    const status = await setup.status(requestOrigin(req));
    return ok(status);
  });

  const ownerSchema = z.object({
    name: z.string(),
    username: z.string(),
    email: z.string(),
    password: z.string(),
  }).strict();

  app.post('/admin/setup/owner', { preHandler: [requireAdminAfterSetup] }, async (req, reply) => {
    const body = ownerSchema.parse((req.body ?? {}) as Record<string, unknown>);
    const user = await users.createFirstOwner(body);
    const session = await auth.createSession(
      (await auth.findUserById(user.id))!,
      req.clientIp ?? null,
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      'admin.setup.owner',
    );
    auth.applySessionCookie(reply, session.token, session.expires_at);
    return ok({ user: session.user, expires_at: session.expires_at });
  });

  /**
   * Wizard progress only. Every question the wizard asks is answered against
   * the endpoint that owns it — model defaults, module switches, host
   * registration — so this pair records nothing but where the operator is and
   * whether they are finished.
   *
   * Same guard as the two routes above: public while the installation is
   * unclaimed, because the wizard starts before an owner exists and wants to
   * record its position from step one.
   */
  const wizardSchema = z
    .object({
      last_step: z.enum(SETUP_WIZARD_STEPS).optional(),
      engines: z.array(z.enum([ENGINE_CODEX, ENGINE_CLAUDE])).optional(),
      completed: z.boolean().optional(),
      dismissed: z.boolean().optional(),
    })
    .strict();

  app.get('/admin/setup/wizard', { preHandler: [requireAdminAfterSetup] }, async () => {
    return ok(await wizard.get());
  });

  app.post('/admin/setup/wizard', { preHandler: [requireAdminAfterSetup] }, async (req) => {
    const body = wizardSchema.parse((req.body ?? {}) as Record<string, unknown>);
    return ok(await wizard.update(body));
  });
}

function requestOrigin(req: FastifyRequest): string {
  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string' ? req.headers['x-forwarded-proto'] : null;
  const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string' ? req.headers['x-forwarded-host'] : null;
  return `${forwardedProto ?? req.protocol}://${forwardedHost ?? req.headers.host ?? 'localhost'}`;
}

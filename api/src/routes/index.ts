import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { Keyring } from '../security/keyring.js';

import { registerHealthRoutes } from './health.js';
import { registerStaticAdminRoutes } from './admin/pages/static.js';

/**
 * Top-level route mounter. Each Phase 2 worktree adds one `register*` call here.
 *
 * Routes that share global middleware (auth, rate limiting, envelope) get them
 * from the app-level plugins registered in `server.ts`. Route-specific guards
 * (e.g. requireHost, requireAdmin) are attached per-route.
 */
export interface RouteContext {
  db: Database;
  env: Env;
  keyring: Keyring;
}

export async function registerAllRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  await registerHealthRoutes(app);
  await registerStaticAdminRoutes(app, ctx);
  // Phase 2 worktrees plug in here:
  //   await registerHostApiRoutes(app, ctx);
  //   await registerAdminAuthRoutes(app, ctx);
  //   await registerAdminUsersRoutes(app, ctx);
  //   await registerAdminHostsRoutes(app, ctx);
  //   await registerAdminOverviewSettingsRoutes(app, ctx);
  //   await registerAdminContentRoutes(app, ctx);
  //   await registerProjectsClientRoutes(app, ctx);
  //   await registerMcpRoutes(app, ctx);
  //   await registerOpenAiCompatRoutes(app, ctx);
  //   await registerAnthropicCompatRoutes(app, ctx);
  //   await registerJoplinManualRoutes(app, ctx);
  //   await registerWrapperV2Routes(app, ctx);
}

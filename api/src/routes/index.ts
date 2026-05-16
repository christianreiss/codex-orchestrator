import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { Keyring } from '../security/keyring.js';

import { registerHealthRoutes } from './health.js';
import { registerStaticAdminRoutes } from './admin/pages/static.js';

import { registerHostApiRoutes } from './host-api/index.js';
import { registerProjectsMcpRoutes } from './projects-mcp/index.js';
import { registerWrapperV2Routes } from './wrapper-v2/index.js';

import { registerOpenAiCompatWorktree } from './openai-compat/index.js';
import { registerAnthropicCompatBundle } from './anthropic-compat/index.js';

import { registerAdminAuthAndUsersRoutes } from './admin-auth-users/index.js';
import { registerAdminHostsRoutes } from './admin/hosts/index.js';
import { registerAdminOverviewSettingsRoutes } from './admin-overview-settings/index.js';
import { registerAdminContentRoutes } from './admin-content/index.js';
import { registerJoplinManualRoutes } from './joplin-manual/index.js';

/**
 * Top-level route mounter. Specific routes register before the static SPA
 * fallback so /admin/* JSON endpoints win the dispatch over index.html.
 */
export interface RouteContext {
  db: Database;
  env: Env;
  keyring: Keyring;
}

export async function registerAllRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  await registerHealthRoutes(app);

  // Host-facing wrapper + auth surface
  await registerHostApiRoutes(app, ctx);
  await registerProjectsMcpRoutes(app, ctx);
  await registerWrapperV2Routes(app, ctx);

  // OpenAI / Anthropic-shaped public APIs (envelope dispatcher selects shape)
  await registerOpenAiCompatWorktree(app, ctx);
  await registerAnthropicCompatBundle(app, ctx);

  // Admin surface
  await registerAdminAuthAndUsersRoutes(app, ctx);
  await registerAdminHostsRoutes(app, ctx);
  await registerAdminOverviewSettingsRoutes(app, ctx);
  await registerAdminContentRoutes(app, ctx);
  await registerJoplinManualRoutes(app, ctx);

  // SPA fallback last (catches HTML GET /admin/* that didn't match a JSON route)
  await registerStaticAdminRoutes(app, ctx);
}

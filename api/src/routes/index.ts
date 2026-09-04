import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { Keyring } from '../security/keyring.js';

import { registerHealthRoutes } from './health.js';
import { registerStaticAdminRoutes } from './admin/pages/static.js';
import { notFoundHandler } from '../http/not-found.js';

import { registerHostApiRoutes } from './host-api/index.js';
import { registerProjectsMcpRoutes } from './projects-mcp/index.js';
import { registerWrapperV2Routes } from './wrapper-v2/index.js';

import { registerOpenAiCompatWorktree } from './openai-compat/index.js';
import { registerAnthropicCompatBundle } from './anthropic-compat/index.js';

import { registerAdminAuthAndUsersRoutes } from './admin-auth-users/index.js';
import { registerAdminHostsRoutes } from './admin/hosts/index.js';
import { registerAdminOverviewSettingsRoutes } from './admin-overview-settings/index.js';
import { registerAdminContentRoutes } from './admin-content/index.js';
import { registerAdminManualRoutes } from './admin/manual/index.js';
import { registerAdminMemoriesRoutes } from './admin/memories/index.js';
import { registerAdminSecretsRoutes } from './admin/secrets/index.js';
import { registerAdminGitDirectorRoutes } from './admin/git-director/index.js';
import { registerAdminAgentSessionsRoutes } from './admin/agent-sessions/index.js';
import { registerAdminProjectBoardRoutes } from './admin/project-board/index.js';
import { registerAgentPortalRoutes } from './agent-portal/index.js';
import { registerAgentMessagingRoutes } from './agent-messaging/index.js';

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
  await registerHealthRoutes(app, ctx);

  // Host-facing wrapper + auth surface
  await registerHostApiRoutes(app, ctx);
  await registerProjectsMcpRoutes(app, ctx);
  await registerWrapperV2Routes(app, ctx);
  await registerAgentPortalRoutes(app, ctx);
  await registerAgentMessagingRoutes(app, ctx);

  // OpenAI / Anthropic-shaped public APIs (envelope dispatcher selects shape)
  await registerOpenAiCompatWorktree(app, ctx);
  await registerAnthropicCompatBundle(app, ctx);

  // Admin surface
  await registerAdminAuthAndUsersRoutes(app, ctx);
  await registerAdminHostsRoutes(app, ctx);
  await registerAdminOverviewSettingsRoutes(app, ctx);
  await registerAdminContentRoutes(app, ctx);
  await registerAdminMemoriesRoutes(app, ctx);
  await registerAdminSecretsRoutes(app, ctx);
  await registerAdminGitDirectorRoutes(app, ctx);
  await registerAdminAgentSessionsRoutes(app, ctx);
  await registerAdminProjectBoardRoutes(app, ctx);
  await registerAdminManualRoutes(app, ctx);

  // SPA fallback last (catches HTML GET /admin/* that didn't match a JSON
  // route). registerStaticAdminRoutes installs its own setNotFoundHandler
  // when STATIC_ROOT is present; otherwise we install a default JSON one.
  const staticInstalled = await registerStaticAdminRoutes(app, ctx);
  if (!staticInstalled) {
    app.setNotFoundHandler(notFoundHandler);
  }
}

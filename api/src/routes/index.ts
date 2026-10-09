import { registerAdminChattyRoutes } from './admin/chatty/index.js';
import { registerHostDaemonRoutes } from './host-daemon.js';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { Keyring } from '../security/keyring.js';

import { registerAgentReceiverRoutes } from './agent-receiver.js';
import { registerCompanionRoutes } from './companion/index.js';
import { registerWatchdogRoutes } from './watchdogs.js';
import { registerScheduleRoutes } from './schedules/index.js';
import { registerHealthRoutes } from './health.js';
import { registerStaticAdminRoutes } from './admin/pages/static.js';
import { notFoundHandler } from '../http/not-found.js';

import { registerHostApiRoutes } from './host-api/index.js';
import { registerProjectsMcpRoutes } from './projects-mcp/index.js';
import { registerWrapperV2Routes } from './wrapper-v2/index.js';

import { registerOpenAiCompatWorktree } from './openai-compat/index.js';
import { registerAnthropicCompatBundle } from './anthropic-compat/index.js';
import { registerGrokCompatRoutes } from './grok-v1/index.js';
import { createGatewayWiring } from '../services/gateway-backends.js';

import { registerAdminAuthAndUsersRoutes } from './admin-auth-users/index.js';
import { registerAdminHostsRoutes } from './admin/hosts/index.js';
import { registerAdminOverviewSettingsRoutes } from './admin-overview-settings/index.js';
import { registerAdminContentRoutes } from './admin-content/index.js';
import { registerAdminManualRoutes } from './admin/manual/index.js';
import { registerAdminMemoriesRoutes } from './admin/memories/index.js';
import { registerAdminAccountsRoutes } from './admin/accounts/index.js';
import { registerAdminGrokRoutes } from './admin/grok/index.js';
import { registerAdminEngineRoutes } from './admin/engines/index.js';
import { registerAdminSecretsRoutes } from './admin/secrets/index.js';
import { registerAdminGitDirectorRoutes } from './admin/git-director/index.js';
import { registerAdminTransfersRoutes } from './admin/transfers/index.js';
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
  await registerHostDaemonRoutes(app, ctx);
  await registerCompanionRoutes(app, ctx);

  // Host-facing wrapper + auth surface
  await registerHostApiRoutes(app, ctx);
  await registerProjectsMcpRoutes(app, ctx);
  await registerWrapperV2Routes(app, ctx);
  await registerAgentPortalRoutes(app, ctx);
  await registerAgentMessagingRoutes(app, ctx);
  await registerScheduleRoutes(app, ctx);
  await registerWatchdogRoutes(app, ctx);
  await registerAgentReceiverRoutes(app, ctx);

  // OpenAI / Anthropic-shaped public APIs (envelope dispatcher selects shape).
  // One backend set for all three surfaces: each engine's bundle — Grok's
  // single auth owner included — exists once, whichever surfaces route to it.
  const gateway = createGatewayWiring(ctx, app.log);
  await registerOpenAiCompatWorktree(app, ctx, gateway);
  await registerAnthropicCompatBundle(app, ctx, { gateway });
  await registerGrokCompatRoutes(app, ctx, { gateway });

  // Admin surface
  await registerAdminAuthAndUsersRoutes(app, ctx);
  await registerAdminHostsRoutes(app, ctx);
  await registerAdminOverviewSettingsRoutes(app, ctx);
  await registerAdminContentRoutes(app, ctx);
  await registerAdminMemoriesRoutes(app, ctx);
  await registerAdminSecretsRoutes(app, ctx);
  await registerAdminAccountsRoutes(app, ctx);
  await registerAdminGrokRoutes(app, ctx);
  await registerAdminEngineRoutes(app, ctx);
  await registerAdminGitDirectorRoutes(app, ctx);
  await registerAdminTransfersRoutes(app, ctx);
  await registerAdminAgentSessionsRoutes(app, ctx);
  await registerAdminProjectBoardRoutes(app, ctx);
  await registerAdminManualRoutes(app, ctx);
  await registerAdminChattyRoutes(app, ctx);

  // SPA fallback last (catches HTML GET /admin/* that didn't match a JSON
  // route). registerStaticAdminRoutes installs its own setNotFoundHandler
  // when STATIC_ROOT is present; otherwise we install a default JSON one.
  const staticInstalled = await registerStaticAdminRoutes(app, ctx);
  if (!staticInstalled) {
    app.setNotFoundHandler(notFoundHandler);
  }
}

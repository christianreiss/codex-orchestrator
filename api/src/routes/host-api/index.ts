import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import { registerAuthRoutes } from '../auth/index.js';
import { registerHostRoutes } from '../host/index.js';
import { registerInstallRoutes } from '../install/index.js';
import { registerCliAuthRoutes } from '../cli-auth/index.js';

/**
 * Single entrypoint for the host-api worktree (Phase 2.1 of BACKEND-redo).
 * Wires the wrapper-facing /auth, /sync/*, /host/*, /versions, /cron/*,
 * /agents/retrieve, /config/retrieve, /install*, /seed/auth/*, and /cli/auth/*
 * routes. The integration step calls this from src/routes/index.ts.
 */
export async function registerHostApiRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  await registerAuthRoutes(app, ctx);
  await registerHostRoutes(app, ctx);
  await registerInstallRoutes(app, ctx);
  await registerCliAuthRoutes(app, ctx);
}

/**
 * Installs the production capability layer on a route-level test app.
 *
 * Route tests build a bare Fastify instance and stub `requireAdmin` so they can
 * pick the caller's role. That was enough while authorization lived in
 * per-route preHandlers, because those came along with the route file. It is
 * not enough now: the guard is attached by an `onRoute` hook, so a test app
 * without the plugin exercises the handler with no authorization at all — and
 * would report a `viewer` reaching a mutation as a pass.
 *
 * This registers the real plugin against a stubbed session, so a role test
 * measures the shipped matrix rather than a copy of it.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../../src/http/errors.js';
import { makeCapabilitiesPlugin } from '../../src/http/plugins/capabilities.js';
import type { AdminContext } from '../../src/http/plugins/auth-admin.js';
import type { AuthorizationMode } from '../../src/security/authorization-mode.js';
import type { AuthorizationModeService } from '../../src/services/authorization-mode.js';

export interface CapabilityStackOptions {
  /** The signed-in role, or `null` for an anonymous caller. */
  role: string | null;
  /** Admin user id the routes will record as the actor. */
  userId?: number;
  /**
   * The fleet's authorization posture. Defaults to `strict`: a route test that
   * has not said otherwise is asking about the matrix, and defaulting to the
   * permissive mode would let a genuine matrix regression pass everywhere.
   */
  mode?: AuthorizationMode;
  /** Receives every request `strict` would have refused under `compatible`. */
  onWouldDeny?: (record: { role: string; capability: string; route: string }) => void;
}

/**
 * Registers a stand-in `auth-admin` (same decorators, no database) followed by
 * the real capabilities plugin. Call before registering routes — the hook only
 * sees routes added after it.
 */
export async function registerCapabilityStack(
  app: FastifyInstance,
  options: CapabilityStackOptions,
): Promise<void> {
  const { role, userId = 7, mode = 'strict', onWouldDeny } = options;

  const context = (): AdminContext | null =>
    role === null
      ? null
      : ({
          user: { id: userId, accessLevel: role, active: 1 },
          session: { id: 1 },
        } as unknown as AdminContext);

  await app.register(
    fp(
      async (instance: FastifyInstance) => {
        instance.decorate('resolveAdmin', async () => context());
        instance.decorate('requireAdmin', async (req: FastifyRequest) => {
          const ctx = context();
          if (!ctx) {
            throw new ApiError('Admin session required', {
              status: 401,
              code: 'admin_required',
              type: 'authentication_error',
            });
          }
          req.admin = ctx;
        });
      },
      { name: 'auth-admin' },
    ),
  );
  // Stands in for the mode service without a database: the plugin only ever
  // asks it for the mode and hands it the dry-run samples.
  const service = {
    getMode: async () => mode,
    recordWouldDeny: async (record: { role: string; capability: string; route: string }) => {
      onWouldDeny?.(record);
    },
  } as unknown as AuthorizationModeService;

  await app.register(makeCapabilitiesPlugin({ service }));
}

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../index.js';
import { registerOpenAiCompatRoutes, type OpenAiCompatOverrides } from '../v1/index.js';
import { ENGINE_GROK } from '../../util/engine.js';
import { createGrokModelsService } from '../../services/grok-models.js';
import { createGrokAuthOwner } from '../../services/grok-auth-owner.js';
import { createAuthTrafficVerifier } from '../../services/auth-traffic-verification.js';
import { createRunnerValidationService } from '../../services/runner-validation.js';
import { createRunnerClient } from '../../services/runner-client.js';

/** Independent Grok subscription gateway using the shared OpenAI wire handlers. */
export async function registerGrokCompatRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  overrides: OpenAiCompatOverrides = {},
): Promise<void> {
  const owner = createGrokAuthOwner({ db: ctx.db, keyring: ctx.keyring, runner: createRunnerClient({ env: ctx.env }) });
  const traffic = createAuthTrafficVerifier({
    db: ctx.db, engine: ENGINE_GROK, log: app.log,
    runnerValidation: createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring }),
    snapshotProvider: () => owner.ensureFresh({ minValiditySeconds: Math.min(600, ctx.env.AUTH_RUNNER_EXEC_TIMEOUT ?? 600) + 300 }),
  });
  const options: OpenAiCompatOverrides = {
    ...overrides,
    engine: ENGINE_GROK,
    models: overrides.models ?? createGrokModelsService(ctx.db),
    authSnapshot: overrides.authSnapshot ?? traffic.getAuthSnapshot,
    onExecSuccess: overrides.onExecSuccess ?? traffic.recordExecSuccess,
  };
  await app.register(async scoped => registerOpenAiCompatRoutes(scoped, ctx, options), { prefix: '/grok' });
}

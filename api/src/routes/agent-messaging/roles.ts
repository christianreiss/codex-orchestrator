import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { UnauthorizedError } from '../../http/errors.js';
import type { AgentMessagingService } from '../../services/agent-messaging.js';
import { createRunnerClaudeAdapter } from '../../services/adapters/runner-claude.js';
import { createAuthTrafficVerifier } from '../../services/auth-traffic-verification.js';
import { createRunnerValidationService } from '../../services/runner-validation.js';
import { RolesService } from '../../services/roles.js';
import { createRunnerRoleJudge } from '../../services/roles/judge.js';
import { SettingsService } from '../../services/settings.js';
import { ENGINE_CLAUDE } from '../../util/engine.js';

/**
 * One RolesService wired to agent messaging (session auth, Server notices) and
 * to the runner-backed judge. With no runner the judge is null and proposals
 * wait in `checking` instead of publishing: the judge may decline, never block,
 * and nothing publishes without it.
 */
export function createRolesService(ctx: RouteContext, messaging: AgentMessagingService, log: FastifyBaseLogger): RolesService {
  const runnerValidation = createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring });
  const traffic = createAuthTrafficVerifier({ db: ctx.db, runnerValidation, engine: ENGINE_CLAUDE, log });
  return new RolesService({
    db: ctx.db,
    settings: new SettingsService(ctx.db),
    judge: createRunnerRoleJudge({
      adapter: createRunnerClaudeAdapter({ env: ctx.env, getAuthSnapshot: traffic.getAuthSnapshot, onExecSuccess: traffic.recordExecSuccess }),
    }),
    authenticateBridge: (sessionId, token) => messaging.authenticateBridge(sessionId, token),
    notifyOwned: async (command, addressIds, body) => { await messaging.noticeAddressesOwned(command, addressIds, body); },
    notify: async (addressIds, body) => {
      await messaging.noticeAddresses(addressIds, body);
    },
  });
}

export function registerRoleRoutes(app: FastifyInstance, ctx: RouteContext, messaging: AgentMessagingService) {
  const roles = createRolesService(ctx, messaging, app.log);
  const bridge = (req: FastifyRequest) => {
    const token = req.headers['x-agent-bridge-token'];
    if (typeof token !== 'string' || !token) throw new UnauthorizedError('Bridge credential required', 'agent_bridge_token_required');
    return { id: z.string().uuid().parse((req.params as { id: string }).id), token };
  };
  const operations: Record<string, (id: string, token: string, body: unknown) => Promise<unknown>> = {
    'roles/activate': (id, token, body) => roles.activate(id, token, body),
    'roles/current': (id, token, body) => roles.current(id, token, body),
    'roles/release': (id, token, body) => roles.release(id, token, body),
    'roles/propose': (id, token, body) => roles.propose(id, token, body),
    'roles/proposals': (id, token, body) => roles.listProposals(id, token, body),
    'roles/review': (id, token, body) => roles.review(id, token, body),
  };
  const invoke = (path: string, req: FastifyRequest) => {
    const { id, token } = bridge(req);
    return operations[path]!(id, token, req.body ?? {});
  };
  app.post('/host/agent-sessions/:id/agent-messaging/roles/activate', (req) => invoke('roles/activate', req));
  app.post('/host/agent-sessions/:id/agent-messaging/roles/current', (req) => invoke('roles/current', req));
  app.post('/host/agent-sessions/:id/agent-messaging/roles/release', (req) => invoke('roles/release', req));
  app.post('/host/agent-sessions/:id/agent-messaging/roles/propose', (req) => invoke('roles/propose', req));
  app.post('/host/agent-sessions/:id/agent-messaging/roles/proposals', (req) => invoke('roles/proposals', req));
  app.post('/host/agent-sessions/:id/agent-messaging/roles/review', (req) => invoke('roles/review', req));

  // The pipeline worker: gates, judge, reviewer assignment, fallback, expiry.
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = roles
      .isEnabled()
      .then((enabled) => (enabled ? roles.processDue() : undefined))
      .catch((error) => app.log.error({ err: error }, 'Role proposal tick failed'))
      .finally(() => {
        running = undefined;
      });
  }, 30_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}

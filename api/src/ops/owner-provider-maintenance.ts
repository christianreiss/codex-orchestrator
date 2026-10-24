import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../routes/index.js';
import { requireOwnerRuntime } from '../control-plane/state/runtime.js';
import { ownerPresence } from '../control-plane/presence.js';
import { createRunnerValidationService } from '../services/runner-validation.js';
import { createCanonicalAuthStoreService } from '../services/canonical-auth-store.js';
import { createRunnerClient } from '../services/runner-client.js';
import { writeRunnerTelemetry } from '../services/runner-telemetry.js';
import { quotaSnapshot } from '../services/quota-observation.js';
import { AgentMessagingService } from '../services/agent-messaging.js';
import { isEngine, type Engine } from '../util/engine.js';
import { isTruthyFlagValue } from '../services/settings.js';
import {
  probeBackoffSeconds,
  runAuthVerificationWorkerTick,
  type AuthProbeScheduleMemory,
} from './auth-verification-worker.js';
import { quotaNoticeId } from './quota-worker.js';
import type { OwnerMaintenanceHandler } from './owner-maintenance-handlers.js';

/** Provider I/O only for a changed input or an actual verification deadline. */
export function createOwnerProviderMaintenance(
  app: FastifyInstance,
  ctx: RouteContext,
): {
  'auth-verification': OwnerMaintenanceHandler;
  'quota-notices': OwnerMaintenanceHandler;
} {
  const runtime = requireOwnerRuntime(ctx.db);
  const runner = createRunnerClient({ env: ctx.env });
  const validation = createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring });
  const authStore = createCanonicalAuthStoreService({
    db: ctx.db,
    keyring: ctx.keyring,
    runner,
    runnerValidation: validation,
  });
  const memory = new Map<string, AuthProbeScheduleMemory>();
  const bus = new AgentMessagingService(ctx.db, ctx.env, ctx.keyring);
  const ttlSeconds = Math.max(1, Number(ctx.env.AUTH_RUNNER_VERIFY_TTL_SECONDS ?? 900));
  const maxIntervalSeconds = Math.max(
    ttlSeconds,
    Number(ctx.env.AUTH_RUNNER_VERIFY_MAX_INTERVAL_SECONDS ?? 21600),
  );
  return {
    async 'auth-verification'(work) {
      const scope = work.key.slice(work.key.indexOf(':') + 1);
      const state = runtime.state.snapshot();
      const account = /^\d+$/.test(scope) ? state.accounts.get(Number(scope)) : undefined;
      const engine = account?.engine ?? scope;
      if (
        !isEngine(engine) ||
        isTruthyFlagValue(state.setting(`${engine}_engine_disabled`)) ||
        (account && (account.state !== 'enabled' || account.mergedIntoAccountId))
      )
        return { observed: true };
      const scheduleMemory =
        memory.get(scope) ?? new Map<Engine, import('./auth-verification-worker.js').AuthProbeAttempt>();
      memory.set(scope, scheduleMemory);
      await runAuthVerificationWorkerTick({
        runnerValidation: {
          ...validation,
          resolveCanonicalPayload: (current) => validation.resolveCanonicalPayload(current, account?.id),
          resolvePendingQuarantine: (current) => validation.resolvePendingQuarantine!(current, account?.id),
        },
        authStore,
        ttlSeconds,
        maxIntervalSeconds,
        reason: 'interval',
        scheduleMemory,
        engines: [engine],
        log: app.log,
        telemetry: { write: (engine, status, at) => writeRunnerTelemetry(ctx.db, engine, status, at) },
      });
      const attempt = scheduleMemory.get(engine);
      if (attempt)
        return {
          retryAt: Math.max(
            Date.now() + 1,
            attempt.lastAttemptMs +
              probeBackoffSeconds(attempt.attempts, ttlSeconds, maxIntervalSeconds) * 1000 +
              1,
          ),
        };
      return { observed: true };
    },
    async 'quota-notices'(work) {
      const snapshot = runtime.state.snapshot(),
        session = snapshot.sessions.get(work.key);
      if (
        !isTruthyFlagValue(snapshot.setting('agent_messaging_enabled')) ||
        !session ||
        session.endedAt ||
        !session.providerAccountId ||
        !session.agentBusAddressId ||
        !isEngine(session.engine) ||
        isTruthyFlagValue(snapshot.setting(`${session.engine}_engine_disabled`))
      )
        return { observed: true };
      if (!ownerPresence(runtime).hasSession(session.id, session.bindingGeneration))
        return { observed: true };
      const q = await quotaSnapshot(ctx.db, session.providerAccountId, session.engine);
      if (!q || q.unlimited || !['enabled', 'paused'].includes(q.account_state)) return { observed: true };
      for (const window of q.windows) {
        const threshold = window.kind === 'short' ? q.policy.short_warn_percent : q.policy.long_warn_percent;
        if (
          window.status !== 'fresh' ||
          !window.resets_at ||
          threshold === null ||
          window.used_percent < threshold
        )
          continue;
        const level = window.used_percent >= 100 ? 'limit' : 'warning';
        const id = quotaNoticeId(
          [session.agentBusAddressId, q.account_id, window.kind, window.resets_at, level].join(':'),
        );
        if (runtime.state.snapshot().messages.by('clientMessageId', id).length) continue;
        const content = `QUOTA/1 ${level}: ${q.engine} account ${q.account_label}; ${window.kind} window ${window.used_percent}% used. Reset ${window.resets_at}; observed ${window.observed_at}. Save a continuation checkpoint and assess remaining work before more delegation. This notice does not pause work. Use quota_get for current policy.`;
        await bus.noticeAddresses([session.agentBusAddressId], content, id);
      }
      return { observed: true };
    },
  };
}

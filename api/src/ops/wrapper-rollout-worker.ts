import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { rolloutSettingsFromEnv, WRAPPER_ROLLOUT_KEY, type WrapperRolloutState } from '../services/wrapper-rollout.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { dependencyRevision } from './schedule-obligations.js';

export function startWrapperRolloutWorker(app: FastifyInstance, db: Database, env: Env): void {
  if (!rolloutSettingsFromEnv(env).enabled) return;
  const commands = requireOwnerMaintenanceCommands(db);
  const tables = ['versions', 'hosts', 'hostDaemons', 'agentPolicyProfiles', 'agentPolicyProfileAssignments'] as const;
  startOwnerWorker(app, db, {
    name: 'wrapper-rollout', tables,
    subscribe: wake => commands.subscribeFacts(wake),
    select(snapshot) {
      const raw = snapshot.setting(WRAPPER_ROLLOUT_KEY);
      if (!raw) return [];
      const state = JSON.parse(raw) as WrapperRolloutState;
      if (state.status !== 'active') return [];
      const revision = `${dependencyRevision(snapshot, tables)}:${commands.facts.revision()}`;
      return [
        { key: `input:${state.id}`, revision, dueAt: 0 },
        { key: `soak:${state.id}`, revision, dueAt: Date.parse(state.stage_started_at) + state.soak_minutes * 60_000 },
      ];
    },
    run: work => commands.run('wrapper-rollout', work),
    error: error => app.log.error({ err: error }, 'owner wrapper rollout failed'),
  });
}

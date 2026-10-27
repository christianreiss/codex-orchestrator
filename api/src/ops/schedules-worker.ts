import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { dependencyRevision } from './schedule-obligations.js';
import { supervisorEnabled } from '../services/agent-supervisor/policy.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { SCHEDULE_TABLES, scheduleObligations, watchdogObligations } from './schedule-obligations.js';

export function startSchedulesWorker(app: FastifyInstance, db: Database, _keyring: Keyring) {
  const commands = requireOwnerMaintenanceCommands(db);
  const tables = [...SCHEDULE_TABLES, 'agentWorkStates', 'agentWorkDependencies', 'workflowRunTasks', 'workflowTaskAttempts', 'workflowRuns'] as const;
  startOwnerWorker(app, db, {
    name: 'supervisor', tables,
    select: snapshot => supervisorEnabled(snapshot) ? [{ key: 'scan', dueAt: 0, revision: dependencyRevision(snapshot, tables) }] : [],
    run: work => commands.run('supervisor', work),
    error: error => app.log.error({ err: error }, 'owner supervisor command failed'),
  });
  startOwnerWorker(app, db, {
    name: 'schedules', tables: SCHEDULE_TABLES, select: snapshot => scheduleObligations(snapshot, commands.facts.revision()),
    subscribe: wake => commands.subscribeFacts(wake),
    run: work => commands.run('schedules', work),
    error: error => app.log.error({ err: error }, 'owner schedule command failed'),
  });
  startOwnerWorker(app, db, {
    name: 'watchdogs', tables: SCHEDULE_TABLES,
    select: snapshot => watchdogObligations(snapshot, commands.facts.sessionConnected, commands.facts.revision()),
    subscribe: wake => commands.subscribeFacts(wake),
    run: work => commands.run('watchdogs', work),
    error: error => app.log.error({ err: error }, 'owner watchdog command failed'),
  });
}

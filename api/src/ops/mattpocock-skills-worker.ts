import type { FastifyInstance } from 'fastify';
import type { SkillSourceState } from '../services/mattpocock-skills.js';

export const MATTPOCOCK_SKILLS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
import type { Database } from '../db/client.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { skillSourceObligations } from './provider-obligations.js';

export interface MattPocockSkillsWorkerService {
  getState(): Promise<SkillSourceState>;
  refresh(options?: { force?: boolean }): Promise<SkillSourceState>;
}

export interface MattPocockSkillsWorkerTickOptions {
  service: MattPocockSkillsWorkerService;
  now?: () => number;
}

/**
 * Refresh only an enabled, auto-following source whose last upstream check is
 * stale. Disabled sources cause no outbound traffic.
 */
export async function runMattPocockSkillsWorkerTick(
  options: MattPocockSkillsWorkerTickOptions,
): Promise<'disabled' | 'manual' | 'fresh' | 'refreshed'> {
  const state = await options.service.getState();
  if (!state.enabled) return 'disabled';
  if (!state.auto_update) return 'manual';
  const checkedAt = state.last_checked_at ? Date.parse(state.last_checked_at) : Number.NaN;
  const now = (options.now ?? Date.now)();
  if (Number.isFinite(checkedAt) && now - checkedAt < MATTPOCOCK_SKILLS_REFRESH_INTERVAL_MS) {
    return 'fresh';
  }
  await options.service.refresh({ force: false });
  return 'refreshed';
}

export function startMattPocockSkillsWorker(
  app: FastifyInstance,
  _service: MattPocockSkillsWorkerService,
  db: Database,
): void {
  const commands = requireOwnerMaintenanceCommands(db);
  startOwnerWorker(app, db, {
    name: 'skill-source', tables: ['versions'], select: skillSourceObligations,
    run: obligation => commands.run('skill-source', obligation),
    error: error => app.log.warn({ err: error }, 'owner skill source refresh failed'),
  });
}

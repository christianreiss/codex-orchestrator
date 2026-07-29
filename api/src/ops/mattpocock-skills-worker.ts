import type { FastifyInstance } from 'fastify';
import type { SkillSourceState } from '../services/mattpocock-skills.js';

export const MATTPOCOCK_SKILLS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const WORKER_POLL_INTERVAL_MS = 30 * 60 * 1000;
const STARTUP_DELAY_MS = 10_000;

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
  service: MattPocockSkillsWorkerService,
): void {
  let running = false;
  let stopped = false;
  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await runMattPocockSkillsWorkerTick({ service });
      if (result === 'refreshed') app.log.info('mattpocock skill source refreshed');
    } catch (err) {
      // Last-known-good rows remain live; a source outage must not make the API
      // unhealthy or block host sync.
      app.log.warn({ err }, 'mattpocock skill source refresh failed');
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void run(), STARTUP_DELAY_MS);
  first.unref?.();
  const timer = setInterval(() => void run(), WORKER_POLL_INTERVAL_MS);
  timer.unref?.();
  app.addHook('onClose', async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  });
}

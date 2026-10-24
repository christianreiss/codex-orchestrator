import { createOwnerWorker } from '../../ops/owner-worker.js';
import { requireOwnerRuntime } from '../../control-plane/state/runtime.js';
import type { ChattyCoordinator } from './coordinator.js';
/** Queue admission and genuine run deadlines, never a scheduler heartbeat. */
export function startOwnedChatty(chatty: ChattyCoordinator, error: (error: unknown) => void) {
  const runtime = requireOwnerRuntime(chatty.ctx.db);
  return createOwnerWorker(runtime, {
    name: 'chatty',
    tables: ['chattyRuns', 'chattySessions', 'chattyActions', 'versions', 'adminUsers', 'adminSessions'],
    select: (s) => {
      const runs = s.table('chattyRuns').all(),
        settings = chatty.store.owned!.settings(s),
        revision = JSON.stringify([runs, settings]);
      const owned = chatty.store.owned!;
      const orphan = runs.some((r) => r.status === 'running' && (!r.claimId || !owned.claims.has(r.claimId)));
      const capacity =
        runs.filter((r) => r.status === 'running' && r.claimId && owned.claims.has(r.claimId)).length <
        settings.concurrency;
      const deadlines = runs.flatMap((r) =>
        ['waiting_input', 'waiting_confirmation'].includes(r.status)
          ? [Date.parse(r.updatedAt) + 1800000]
          : r.status === 'queued' && settings.enabled
            ? [capacity ? 0 : Date.parse(r.updatedAt) + 300000]
            : [],
      );
      if (orphan && settings.enabled) deadlines.push(0);
      return deadlines.length ? [{ key: 'chatty-work', dueAt: Math.min(...deadlines), revision }] : [];
    },
    run: async () => {
      await chatty.tick();
      return { observed: true };
    },
    error,
  });
}

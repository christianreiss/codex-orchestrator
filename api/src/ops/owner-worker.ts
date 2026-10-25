import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import { requireOwnerRuntime, type OwnerRuntime } from '../control-plane/state/runtime.js';
import type { OwnerStateSnapshot } from '../control-plane/state/store.js';
import type { OwnedTableName } from '../control-plane/state/catalog.js';

export interface OwnerWorkObligation {
  key: string;
  dueAt: number;
  /** Changes whenever the durable input giving rise to this obligation changes. */
  revision: string;
}
export type OwnerWorkResult = void | { retryAt: number } | { retryAfterMs: number } | { observed: true };
export const OWNER_WORK_RETRY_MS = 30_000;
export interface OwnerWorkerOptions {
  name: string;
  tables: readonly OwnedTableName[];
  select(snapshot: OwnerStateSnapshot, now: number): readonly OwnerWorkObligation[];
  /** Success must retire/change the obligation in owner state, or name its next real deadline. */
  run(obligation: OwnerWorkObligation): Promise<OwnerWorkResult>;
  retryMs?: number;
  subscribe?(wake: () => void): () => void;
  error(error: unknown): void;
}
const token = (work: OwnerWorkObligation) => JSON.stringify([work.key, work.revision, work.dueAt]);

/** Event/deadline worker. No timer exists when there is no known obligation. */
export function createOwnerWorker(runtime: OwnerRuntime, options: OwnerWorkerOptions) {
  const queueKey = `worker:${options.name}`;
  const retryMs = Math.max(1000, options.retryMs ?? OWNER_WORK_RETRY_MS);
  let stopped = false;
  let active: Promise<void> | undefined;
  let selected: readonly OwnerWorkObligation[] = [];
  let views: unknown[] = [];
  const retries = new Map<string, number>();
  const observed = new Set<string>();

  function rescan(force = false): void {
    if (stopped) return;
    runtime.assertOwner();
    const snapshot = runtime.state.snapshot();
    const nextViews = options.tables.map((table) => snapshot.table(table));
    if (!force && nextViews.every((view, i) => view === views[i])) return;
    views = nextViews;
    selected = options.select(snapshot, Date.now());
    const keys = new Set<string>();
    for (const work of selected) {
      if (!work.key || !Number.isFinite(work.dueAt) || keys.has(work.key))
        throw new Error(`Invalid ${options.name} obligation`);
      keys.add(work.key);
    }
    const retained = new Set(selected.map(token));
    for (const key of retries.keys()) if (!retained.has(key)) retries.delete(key);
    for (const key of observed) if (!retained.has(key)) observed.delete(key);
    selected = selected.filter((work) => !observed.has(token(work)));
    arm();
  }
  function effective(work: OwnerWorkObligation) {
    return Math.max(work.dueAt, retries.get(token(work)) ?? -Infinity);
  }
  function arm(): void {
    runtime.deadlines.cancel(queueKey);
    if (stopped || active || !selected.length) return;
    const next = selected.reduce((a, b) => (effective(a) <= effective(b) ? a : b));
    runtime.deadlines.schedule(queueKey, effective(next), () => run(next));
  }
  function run(candidate: OwnerWorkObligation): Promise<void> | undefined {
    if (stopped || active) return;
    // A delayed timer never runs a canceled/replaced obligation.
    rescan(true);
    runtime.deadlines.cancel(queueKey);
    const current = selected.find((work) => token(work) === token(candidate));
    if (!current || effective(current) > Date.now()) {
      arm();
      return;
    }
    active = Promise.resolve()
      .then(async () => {
        runtime.assertOwner();
        const result = await options.run(current);
        if (stopped) return;
        rescan(true);
        if (result && 'observed' in result) {
          observed.add(token(current));
          rescan(true);
        } else if (result) {
          // Relative waits start after the await and owner-state rescan. A valid
          // short delay must not become invalid while its result is consumed.
          const now = Date.now();
          const retryAt = 'retryAfterMs' in result ? now + result.retryAfterMs : result.retryAt;
          if (!Number.isFinite(retryAt) || retryAt <= now)
            throw new Error(`${options.name} returned a nonfuture retry deadline`);
          retries.set(token(current), retryAt);
        } else if (selected.some((work) => token(work) === token(current) && work.dueAt <= Date.now())) {
          throw new Error(`${options.name} completed without retiring its due owner-state obligation`);
        }
      })
      .catch((error) => {
        retries.set(token(current), Date.now() + retryMs);
        options.error(error);
      })
      .finally(() => {
        active = undefined;
        if (!stopped) arm();
      });
    return active;
  }
  const unsubscribe = runtime.state.subscribe(() => {
    rescan();
  });
  const unsubscribeExternal =
    options.subscribe?.(() => {
      rescan(true);
    }) ?? (() => {});
  try {
    rescan(true);
  } catch (error) {
    unsubscribe();
    unsubscribeExternal();
    runtime.deadlines.cancel(queueKey);
    throw error;
  }
  return {
    wake() {
      rescan(true);
    },
    async close() {
      stopped = true;
      unsubscribe();
      unsubscribeExternal();
      runtime.deadlines.cancel(queueKey);
      await active;
    },
  };
}

export function startOwnerWorker(app: FastifyInstance, db: Database, options: OwnerWorkerOptions): void {
  const worker = createOwnerWorker(requireOwnerRuntime(db), options);
  app.addHook('onClose', async () => {
    await worker.close();
  });
}

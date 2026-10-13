import { ConflictError } from '../../../http/errors.js';

/**
 * One execution per `client_message_id`, for operations whose effect must not
 * happen twice (closing a socket, stopping a process).
 *
 * The slot is taken BEFORE the operation's first await, so two clicks, or a retry
 * racing its original, that arrive while the first is still running share its
 * outcome instead of dispatching again. A failed attempt frees the key so the
 * operator can retry it. A key used for another target or another action is
 * refused before anything happens.
 *
 * Memory is bounded by dropping the oldest SETTLED entries. An entry whose
 * operation is still running is never dropped, whatever the size: dropping it
 * would let a retry of that very key dispatch a second time, which is the one
 * thing this ledger exists to prevent. The number of running operations is bounded
 * by their own deadlines, not by this cap.
 */
export class OperationLedger<Kind extends string> {
  private readonly entries = new Map<string, { at: number; target: string; kind: Kind; promise: Promise<unknown>; settled: boolean }>();

  constructor(
    private readonly options: { ttlMs: number; max: number; now?: () => number },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  async once<T extends { replayed: boolean }>(key: string, target: string, kind: Kind, run: () => Promise<T>): Promise<T> {
    const now = (this.options.now ?? Date.now)();
    for (const [k, entry] of this.entries) if (entry.settled && now - entry.at > this.options.ttlMs) this.entries.delete(k);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.target !== target || existing.kind !== kind) {
        throw new ConflictError('client_message_id was already used for another target', 'client_message_id_reused');
      }
      return { ...((await existing.promise) as T), replayed: true };
    }
    if (this.entries.size >= this.options.max) {
      for (const [k, entry] of this.entries) {
        if (this.entries.size < this.options.max) break;
        if (entry.settled) this.entries.delete(k);
      }
    }
    const promise = run();
    const entry = { at: now, target, kind, promise, settled: false };
    this.entries.set(key, entry);
    try {
      return await promise;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    } finally {
      entry.settled = true;
    }
  }
}

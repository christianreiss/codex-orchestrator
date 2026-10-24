import { eq } from 'drizzle-orm';
import type { Json } from './commands.js';
import { mutateOwnerState, type OwnerRuntime } from './state/runtime.js';
import { controlPlaneOutbox } from '../db/schema.js';

export type EffectOutcome =
  | { status: 'delivered' }
  | { status: 'retry'; afterMs: number }
  | { status: 'uncertain' };
export type EffectHandler = (input: { id: string; target: string; payload: Json }) => Promise<EffectOutcome>;

/**
 * A durable dispatch attempt precedes external I/O. Unfinished dispatches after
 * restart are uncertain, never silently redelivered to a non-idempotent provider.
 */
export class OutboxDispatcher {
  private unsubscribe?: () => void;
  private readonly scheduled = new Map<string, string>();
  private readonly running = new Set<string>();
  private readonly active = new Set<Promise<void>>();
  private closed = false;
  private previous?: object;
  constructor(
    private readonly runtime: OwnerRuntime,
    private readonly options: {
      handlers: ReadonlyMap<string, EffectHandler>;
      /** Only effects whose receiver durably deduplicates the same id/payload. */
      replaySafeKinds?: ReadonlySet<string>;
      readPayload(id: string): Promise<Json>;
      error(error: unknown, id: string): void;
    },
  ) {}

  async start(): Promise<void> {
    if (this.unsubscribe || this.closed) throw new Error('Outbox dispatcher already started/stopped');
    // A prior process may have sent its effect before losing the result ACK.
    for (const row of this.runtime.state.snapshot().table('controlPlaneOutbox').by('status', 'dispatching'))
      await this.transition(
        row.id,
        'dispatching',
        this.options.replaySafeKinds?.has(row.kind) ? 'pending' : 'uncertain',
        row.availableAt,
      );
    this.unsubscribe = this.runtime.state.subscribe(() => this.refresh());
    this.refresh();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const id of this.scheduled.keys()) this.runtime.deadlines.cancel('outbox:' + id);
    this.scheduled.clear();
    await Promise.allSettled([...this.active]);
  }
  private refresh(): void {
    if (this.closed) return;
    const view = this.runtime.state.snapshot().table('controlPlaneOutbox');
    if (view === this.previous) return;
    this.previous = view;
    const pending = new Set<string>();
    for (const row of view.by('status', 'pending')) {
      pending.add(row.id);
      if (this.running.has(row.id) || this.scheduled.get(row.id) === row.availableAt) continue;
      const at = Date.parse(row.availableAt);
      if (!Number.isFinite(at)) throw new Error(`Invalid outbox deadline ${row.id}`);
      this.scheduled.set(row.id, row.availableAt);
      this.runtime.deadlines.schedule('outbox:' + row.id, at, () => {
        const pending = this.dispatch(row.id);
        this.active.add(pending);
        void pending.then(
          () => this.active.delete(pending),
          () => this.active.delete(pending),
        );
        return pending;
      });
    }
    for (const id of this.scheduled.keys()) {
      if (!pending.has(id)) {
        this.runtime.deadlines.cancel('outbox:' + id);
        this.scheduled.delete(id);
      }
    }
  }
  private async transition(
    id: string,
    expected: string,
    status: string,
    availableAt: string,
  ): Promise<boolean> {
    let transitioned = false;
    await mutateOwnerState(this.runtime, {
      kind: 'outbox.' + status,
      principal: 'system:outbox',
      payload: { id, expected, status, availableAt },
      prepare: ({ snapshot, draft, write }) => {
        const row = snapshot.table('controlPlaneOutbox').get(id);
        if (!row || row.status !== expected) return false;
        const completedAt = status === 'delivered' ? new Date().toISOString() : null;
        const next = {
          ...row,
          status,
          availableAt,
          completedAt,
          attempts: row.attempts + (status === 'dispatching' ? 1 : 0),
        };
        if (completedAt) draft.remove('controlPlaneOutbox', id);
        else draft.upsert('controlPlaneOutbox', next);
        write((tx) =>
          tx
            .update(controlPlaneOutbox)
            .set({ status, availableAt, completedAt, attempts: next.attempts })
            .where(eq(controlPlaneOutbox.id, id)),
        );
        transitioned = true;
        return true;
      },
    });
    return transitioned;
  }
  private async dispatch(id: string): Promise<void> {
    this.scheduled.delete(id);
    if (this.closed || this.running.has(id)) return;
    this.runtime.assertOwner();
    const row = this.runtime.state.snapshot().table('controlPlaneOutbox').get(id);
    if (!row || row.status !== 'pending') return;
    this.running.add(id);
    let invoked = false;
    try {
      const handler = this.options.handlers.get(row.kind);
      if (!handler) throw new Error(`No outbox handler registered for ${row.kind}`);
      const payload = await this.options.readPayload(id);
      if (this.closed) return;
      if (!(await this.transition(id, 'pending', 'dispatching', row.availableAt))) return;
      this.runtime.assertOwner();
      invoked = true;
      const result = await handler({ id, target: row.target, payload });
      this.runtime.assertOwner();
      if (result.status === 'retry') {
        if (!Number.isFinite(result.afterMs) || result.afterMs < 1)
          throw new Error('Invalid external effect retry delay');
        await this.transition(
          id,
          'dispatching',
          'pending',
          new Date(Date.now() + result.afterMs).toISOString(),
        );
      } else await this.transition(id, 'dispatching', result.status, row.availableAt);
    } catch (error) {
      this.options.error(error, id);
      // Only handlers can prove a retry safe. Unknown failures stay visible.
      try {
        await this.transition(
          id,
          invoked ? 'dispatching' : 'pending',
          invoked && this.options.replaySafeKinds?.has(row.kind) ? 'pending' : 'uncertain',
          new Date(Date.now() + 5000).toISOString(),
        );
      } catch (recordError) {
        this.options.error(recordError, id);
      }
    } finally {
      this.running.delete(id);
      this.previous = undefined;
      this.refresh();
    }
  }
}

import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { clientConfigDocuments } from '../db/schema.js';
import type { Engine } from '../util/engine.js';

export interface ConfigWriteContext {
  /** Queue notifications only for this transaction's successful commit. */
  afterCommit: (notify: () => void) => void;
}

/** Serialize each engine's canonical config writers, including missing heads. */
export async function withClientConfigWriteLock<T>(
  db: Database,
  engine: Engine,
  write: (tx: Database, existing: boolean, context: ConfigWriteContext) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const notifications: Array<() => void> = [];
    let result: T;
    try {
      result = await db.transaction(async tx => {
        // Repeatable-read locks the indexed range even when it is empty.
        const [head] = await tx.select({ id: clientConfigDocuments.id })
          .from(clientConfigDocuments)
          .where(eq(clientConfigDocuments.engine, engine))
          .orderBy(desc(clientConfigDocuments.id))
          .limit(1)
          .for('update');
        return write(tx as unknown as Database, Boolean(head), {
          afterCommit: notify => { notifications.push(notify); },
        });
      }, { isolationLevel: 'repeatable read' });
    } catch (error) {
      // Empty-range gap locks can deadlock when upgraded to an insert. Retry
      // only an explicitly rolled-back transaction, never an uncertain write.
      let cause: unknown = error;
      let deadlock = false;
      for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth += 1) {
        const detail = cause as { code?: unknown; errno?: unknown; cause?: unknown };
        if (detail.code === 'ER_LOCK_DEADLOCK' || detail.errno === 1213) deadlock = true;
        cause = detail.cause;
      }
      if (!deadlock || attempt >= 2) throw error;
      continue;
    }
    // Outside the retry block: a notification error can never replay a
    // transaction that has already committed.
    for (const notify of notifications) notify();
    return result;
  }
}

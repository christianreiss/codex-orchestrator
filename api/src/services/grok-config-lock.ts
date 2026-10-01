import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { clientConfigDocuments } from '../db/schema.js';
import { ENGINE_GROK } from '../util/engine.js';

/** Serialize Grok config writers before allocating a canonical row id. */
export async function withGrokConfigWriteLock<T>(
  db: Database,
  write: (tx: Database, existing: boolean) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async tx => {
        // Repeatable-read locks the indexed range even when it is empty.
        const [head] = await tx.select({ id: clientConfigDocuments.id })
          .from(clientConfigDocuments)
          .where(eq(clientConfigDocuments.engine, ENGINE_GROK))
          .orderBy(desc(clientConfigDocuments.id))
          .limit(1)
          .for('update');
        return write(tx as unknown as Database, Boolean(head));
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
    }
  }
}

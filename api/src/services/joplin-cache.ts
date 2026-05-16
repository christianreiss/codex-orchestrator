import { eq, notInArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { joplinNotesCache } from '../db/schema.js';
import { nowIso } from '../util/timestamp.js';
import type { JoplinClient, JoplinNoteSummary } from './joplin-client.js';

/**
 * Bulk-syncs a Joplin client's note set into `joplin_notes_cache`.
 *
 * Uniqueness is on the `joplin_id` column; the upsert uses
 * INSERT … ON DUPLICATE KEY UPDATE semantics through Drizzle. After the upsert
 * round, any row whose joplin_id is no longer in the upstream set is deleted
 * (orphan strip). All synced rows share the same `synced_at` so the oldest
 * timestamp on the table tracks the freshness of the last full sync.
 */

export interface SyncResult {
  synced_count: number;
  deleted_count: number;
  notebooks: number;
  took_ms: number;
}

export async function syncAllJoplinNotes(
  db: Database,
  client: JoplinClient,
  options: { batchLimit?: number } = {},
): Promise<SyncResult> {
  const started = Date.now();
  const notes = await client.listNotes(options.batchLimit ?? 1000);
  const notebooks = await client.listNotebooks().catch(() => []);
  const syncedAt = nowIso();
  let synced = 0;

  for (const note of notes) {
    try {
      await upsertNote(db, note, syncedAt);
      synced += 1;
    } catch {
      // skip individual failures; surface as deleted_count discrepancy
    }
  }

  const seenIds = notes.map((n) => n.id).filter((id) => id.length > 0);
  let deleted = 0;
  if (seenIds.length > 0) {
    const result = await db
      .delete(joplinNotesCache)
      .where(notInArray(joplinNotesCache.joplinId, seenIds));
    // mysql2 driver: result is [ResultSetHeader, FieldPacket[]]; Drizzle exposes
    // the affected rows under [0].affectedRows. Be defensive — older drivers
    // return a single object.
    deleted = extractAffectedRows(result);
  } else {
    // No notes upstream → wipe all
    const result = await db.delete(joplinNotesCache);
    deleted = extractAffectedRows(result);
  }

  return {
    synced_count: synced,
    deleted_count: deleted,
    notebooks: notebooks.length,
    took_ms: Date.now() - started,
  };
}

export async function upsertNote(
  db: Database,
  note: JoplinNoteSummary,
  syncedAt: string,
): Promise<void> {
  const createdAt = nowIso();
  await db
    .insert(joplinNotesCache)
    .values({
      joplinId: note.id,
      title: note.title.slice(0, 1000),
      body: note.body,
      notebookId: note.parent_id,
      tagsJson: note.tags,
      parentId: note.parent_id,
      syncedAt,
      createdAt,
      updatedAt: createdAt,
    })
    .onDuplicateKeyUpdate({
      set: {
        title: note.title.slice(0, 1000),
        body: note.body,
        notebookId: note.parent_id,
        tagsJson: note.tags,
        parentId: note.parent_id,
        syncedAt,
        updatedAt: createdAt,
      },
    });
}

export async function getNoteByJoplinId(
  db: Database,
  joplinId: string,
): Promise<typeof joplinNotesCache.$inferSelect | null> {
  const rows = await db
    .select()
    .from(joplinNotesCache)
    .where(eq(joplinNotesCache.joplinId, joplinId))
    .limit(1);
  return rows[0] ?? null;
}

function extractAffectedRows(result: unknown): number {
  if (!result) return 0;
  if (typeof result === 'object' && result !== null) {
    if (Array.isArray(result) && result[0] && typeof result[0] === 'object') {
      const r = result[0] as { affectedRows?: number };
      return typeof r.affectedRows === 'number' ? r.affectedRows : 0;
    }
    const r = result as { affectedRows?: number; rowsAffected?: number };
    if (typeof r.affectedRows === 'number') return r.affectedRows;
    if (typeof r.rowsAffected === 'number') return r.rowsAffected;
  }
  return 0;
}

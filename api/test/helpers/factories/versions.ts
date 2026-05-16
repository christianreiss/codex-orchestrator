import { eq } from 'drizzle-orm';
import { versions, type Version } from '../../../src/db/schema.js';
import { nowIso } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';

/**
 * Generic key-value setting helper for the `versions` table. Upserts by
 * primary key (`name`). Returns the stored row.
 *
 * Mirrors the legacy PHP `VersionRepository::set()` semantics — used both for
 * literal version strings and as a generic singleton settings bag.
 */
export async function setSetting(
  db: TestDb,
  name: string,
  value: string,
): Promise<Version> {
  const now = nowIso();
  const existing = await db.select().from(versions).where(eq(versions.name, name)).limit(1);
  if (existing[0]) {
    await db
      .update(versions)
      .set({ version: value, updatedAt: now })
      .where(eq(versions.name, name));
  } else {
    await db.insert(versions).values({ name, version: value, updatedAt: now });
  }
  const [row] = await db.select().from(versions).where(eq(versions.name, name)).limit(1);
  if (!row) throw new Error('setSetting: row not found after upsert');
  return row;
}

export async function getSetting(db: TestDb, name: string): Promise<string | null> {
  const [row] = await db.select().from(versions).where(eq(versions.name, name)).limit(1);
  return row ? row.version : null;
}

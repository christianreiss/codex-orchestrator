/**
 * Generic typed settings reader/writer backed by the `versions` table. The
 * legacy PHP code stored arbitrary key/value pairs in `versions` (name/version
 * columns) under a wide variety of keys; we preserve that convention so old
 * rows stay readable.
 *
 * Every mutation publishes a `settings.changed` WS event.
 */

import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { versions } from '../db/schema.js';
import { wsPublisher } from '../ws/publisher.js';
import { nowIso } from '../util/timestamp.js';

const TRUTHY_FLAG_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Single source of truth for reading a `versions` row value as a boolean.
 * Values are trimmed and case-folded; a missing or blank value means "unset"
 * and yields `defaultValue`. Both proxy kill switches parse their flag through
 * here so the admin API and the running proxy can never disagree.
 */
export function isTruthyFlagValue(raw: string | null | undefined, defaultValue = false): boolean {
  if (raw == null) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return defaultValue;
  return TRUTHY_FLAG_VALUES.has(normalized);
}

export class SettingsService {
  constructor(private readonly db: Database) {}

  async getRaw(key: string): Promise<string | null> {
    const rows = await this.db
      .select({ version: versions.version, updatedAt: versions.updatedAt })
      .from(versions)
      .where(eq(versions.name, key))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return row.version ?? null;
  }

  async getWithMeta(key: string): Promise<{ value: string | null; updatedAt: string | null }> {
    const rows = await this.db
      .select({ version: versions.version, updatedAt: versions.updatedAt })
      .from(versions)
      .where(eq(versions.name, key))
      .limit(1);
    const row = rows[0];
    if (!row) return { value: null, updatedAt: null };
    return { value: row.version ?? null, updatedAt: row.updatedAt ?? null };
  }

  async getFlag(key: string, defaultValue = false): Promise<boolean> {
    return isTruthyFlagValue(await this.getRaw(key), defaultValue);
  }

  async getInt(key: string, defaultValue: number): Promise<number> {
    const raw = await this.getRaw(key);
    if (raw === null || raw === '') return defaultValue;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : defaultValue;
  }

  async getString(key: string, defaultValue: string | null = null): Promise<string | null> {
    const raw = await this.getRaw(key);
    return raw ?? defaultValue;
  }

  async set(key: string, value: string, options: { publish?: boolean } = {}): Promise<void> {
    const now = nowIso();
    const existing = await this.db
      .select({ name: versions.name })
      .from(versions)
      .where(eq(versions.name, key))
      .limit(1);
    if (existing.length > 0) {
      await this.db
        .update(versions)
        .set({ version: value, updatedAt: now })
        .where(eq(versions.name, key));
    } else {
      try {
        await this.db.insert(versions).values({ name: key, version: value, updatedAt: now });
      } catch {
        // Race: another writer beat us. Retry as update.
        await this.db
          .update(versions)
          .set({ version: value, updatedAt: now })
          .where(eq(versions.name, key));
      }
    }
    if (options.publish !== false) {
      wsPublisher.publish('settings.changed', { key });
    }
  }

  async setFlag(key: string, value: boolean, options?: { publish?: boolean }): Promise<void> {
    await this.set(key, value ? '1' : '0', options);
  }

  async setInt(key: string, value: number, options?: { publish?: boolean }): Promise<void> {
    await this.set(key, String(Math.trunc(value)), options);
  }

  async delete(key: string, options: { publish?: boolean } = {}): Promise<void> {
    await this.db.delete(versions).where(eq(versions.name, key));
    if (options.publish !== false) {
      wsPublisher.publish('settings.changed', { key });
    }
  }

  /**
   * Compare-and-delete: removes the key only if it still holds `expected`.
   * Returns true when this caller is the one that removed it.
   *
   * The insecure fleet window uses this to elect a single closer. Two sweepers
   * can observe the same lapsed deadline, and an unconditional delete would let
   * the loser wipe a *fresh* window an operator opened in between, leaving every
   * host row carrying a deadline with no key left to close it.
   */
  async deleteIf(
    key: string,
    expected: string,
    options: { publish?: boolean } = {},
  ): Promise<boolean> {
    const result = await this.db
      .delete(versions)
      .where(and(eq(versions.name, key), eq(versions.version, expected)));
    // mysql2 returns [{ affectedRows }]; the count is what elects the winner.
    const removed = Number((result as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0) > 0;
    if (removed && options.publish !== false) {
      wsPublisher.publish('settings.changed', { key });
    }
    return removed;
  }
}

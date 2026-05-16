/**
 * Generic typed settings reader/writer backed by the `versions` table. The
 * legacy PHP code stored arbitrary key/value pairs in `versions` (name/version
 * columns) under a wide variety of keys; we preserve that convention so old
 * rows stay readable.
 *
 * Every mutation publishes a `settings.changed` WS event.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { versions } from '../db/schema.js';
import { wsPublisher } from '../ws/publisher.js';
import { nowIso } from '../util/timestamp.js';

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
    const raw = await this.getRaw(key);
    if (raw === null || raw === '') return defaultValue;
    return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
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
}

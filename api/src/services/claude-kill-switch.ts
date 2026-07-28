/**
 * Reads the admin-toggleable `claude_api_disabled` flag from the `versions`
 * table. When set, every /anthropic/v1/* route (except OPTIONS) returns 503
 * with an Anthropic-shaped error envelope.
 *
 * Mirrors the legacy `VersionRepository::getFlag('claude_api_disabled', false)`
 * + public/index.php kill-switch branch.
 */
import { eq } from 'drizzle-orm';
import { versions } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import { isTruthyFlagValue } from './settings.js';

const FLAG = 'claude_api_disabled';

export interface ClaudeKillSwitch {
  isDisabled(): Promise<boolean>;
  /**
   * Throws an Anthropic-shaped 503 ApiError when the kill-switch is set.
   * No-op otherwise.
   */
  ensureEnabled(): Promise<void>;
  /** Admin setter. */
  setDisabled(disabled: boolean): Promise<void>;
}

export function createClaudeKillSwitch(db: Database): ClaudeKillSwitch {
  // Tiny TTL cache to keep the hot path off the DB for SSE streams that hit it
  // multiple times in a single request span (e.g. ensureEnabled then auth).
  let cache: { value: boolean; ts: number } | null = null;
  const TTL_MS = 1_000;

  async function read(): Promise<boolean> {
    if (cache && Date.now() - cache.ts < TTL_MS) return cache.value;
    try {
      const rows = await db.select().from(versions).where(eq(versions.name, FLAG)).limit(1);
      const value = isTruthyFlagValue(rows[0]?.version);
      cache = { value, ts: Date.now() };
      return value;
    } catch {
      // If the versions table is unreachable we fail open — refusing every
      // request because the metadata table glitched is worse than serving.
      return false;
    }
  }

  return {
    isDisabled: read,

    async ensureEnabled() {
      if (await read()) {
        throw new ApiError('Claude API is currently disabled by administrator', {
          status: 503,
          code: 'api_disabled',
          type: 'api_error',
        });
      }
    },

    async setDisabled(disabled) {
      const now = new Date().toISOString();
      const value = disabled ? 'true' : 'false';
      const existing = await db.select().from(versions).where(eq(versions.name, FLAG)).limit(1);
      if (existing[0]) {
        await db.update(versions).set({ version: value, updatedAt: now }).where(eq(versions.name, FLAG));
      } else {
        await db.insert(versions).values({ name: FLAG, version: value, updatedAt: now });
      }
      cache = null;
    },
  };
}

import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { versions } from '../db/schema.js';
import { ApiError } from '../http/errors.js';

/**
 * Reads the `versions` table for the `openai_api_disabled` row. When the value
 * is truthy ("1", "true", "yes", "on") all `/v1/*` non-OPTIONS routes refuse
 * to run with an OpenAI-shape 503.
 *
 * The flag is consulted on every request — admins flip it via
 * `/admin/settings/openai/state`, which is owned by the admin-settings
 * worktree.
 */

const FLAG_NAME = 'openai_api_disabled';
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export interface KillSwitch {
  isDisabled(): Promise<boolean>;
  throwIfDisabled(): Promise<void>;
}

export function makeOpenAiKillSwitch(db: Database): KillSwitch {
  return {
    async isDisabled() {
      try {
        const rows = await db
          .select({ value: versions.version })
          .from(versions)
          .where(eq(versions.name, FLAG_NAME))
          .limit(1);
        const raw = rows[0]?.value;
        if (raw == null) return false;
        return TRUTHY.has(String(raw).toLowerCase().trim());
      } catch {
        // If the version table is unreachable we fail open — refusing every
        // request because the metadata table glitched is worse than serving.
        return false;
      }
    },
    async throwIfDisabled() {
      if (await this.isDisabled()) {
        throw new ApiError('OpenAI API disabled by administrator', {
          status: 503,
          code: 'api_disabled',
          type: 'api_error',
        });
      }
    },
  };
}

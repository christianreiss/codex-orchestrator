import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { versions } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { isTruthyFlagValue } from './settings.js';

/**
 * Reads owned `versions` metadata for the `openai_api_disabled` row, or the
 * database in legacy fixtures. Owner loss always fails closed. When the value
 * is truthy (see `isTruthyFlagValue`) all `/v1/*` non-OPTIONS routes refuse to
 * run with an OpenAI-shape 503.
 *
 * The flag is consulted on every request — admins flip it via
 * `/admin/settings/openai/state`, which is owned by the admin-settings
 * worktree.
 */

const FLAG_NAME = 'openai_api_disabled';

export interface KillSwitch {
  isDisabled(): Promise<boolean>;
  throwIfDisabled(): Promise<void>;
}

export function makeOpenAiKillSwitch(db: Database, flagName = FLAG_NAME, label = 'OpenAI', disabledByDefault = false): KillSwitch {
  return {
    async isDisabled() {
      const owner = ownerRuntimeFor(db);
      if (owner) {
        owner.assertOwner();
        return isTruthyFlagValue(owner.state.snapshot().table('versions').get(flagName)?.version ?? (disabledByDefault ? '1' : undefined));
      }
      try {
        const rows = await db
          .select({ value: versions.version })
          .from(versions)
          .where(eq(versions.name, flagName))
          .limit(1);
        return isTruthyFlagValue(rows[0]?.value ?? (disabledByDefault ? '1' : undefined));
      } catch {
        // Preserve legacy availability on failed reads. Opt-in surfaces
        // (Kimi) stay disabled when their switch cannot be verified.
        return disabledByDefault;
      }
    },
    async throwIfDisabled() {
      if (await this.isDisabled()) {
        throw new ApiError(`${label} API disabled by administrator`, {
          status: 503,
          code: 'api_disabled',
          type: 'api_error',
        });
      }
    },
  };
}

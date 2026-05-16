import { existsSync, statSync } from 'node:fs';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { Keyring } from '../security/keyring.js';
import { sql } from 'drizzle-orm';

export async function runBootChecks(env: Env, db: Database): Promise<void> {
  Keyring.fromEnv(env);

  await db.execute(sql`SELECT 1`);

  if (env.STATIC_ROOT) {
    if (!existsSync(env.STATIC_ROOT) || !statSync(env.STATIC_ROOT).isDirectory()) {
      // Non-fatal: log and continue; static plugin will surface 404s.
      // eslint-disable-next-line no-console
      console.warn(`[boot] STATIC_ROOT not found or not a directory: ${env.STATIC_ROOT}`);
    }
  }
}

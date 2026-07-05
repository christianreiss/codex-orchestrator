import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { ENGINE_CLAUDE, type Engine } from '../util/engine.js';

export type RunnerTelemetryState = 'ok' | 'fail';

export async function writeRunnerTelemetry(
  db: Database,
  engine: Engine,
  state: RunnerTelemetryState,
  checkedAt: string,
): Promise<void> {
  const suffix = engine === ENGINE_CLAUDE ? '_claude' : '';
  await upsertVersion(db, `runner_state${suffix}`, state, checkedAt);
  await upsertVersion(db, `runner_last_check${suffix}`, checkedAt, checkedAt);
  await upsertVersion(
    db,
    state === 'ok' ? `runner_last_ok${suffix}` : `runner_last_fail${suffix}`,
    checkedAt,
    checkedAt,
  );
}

async function upsertVersion(
  db: Database,
  name: string,
  version: string,
  updatedAt: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO versions (name, version, updated_at)
    VALUES (${name}, ${version}, ${updatedAt})
    ON DUPLICATE KEY UPDATE version = VALUES(version), updated_at = VALUES(updated_at)
  `);
}

import { ownerRuntimeFor, mutateOwnerState } from '../control-plane/state/runtime.js';
import { versions } from '../db/schema.js';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { ENGINE_CODEX, type Engine } from '../util/engine.js';

export type RunnerTelemetryState = 'ok' | 'fail';

export async function writeRunnerTelemetry(
  db: Database,
  engine: Engine,
  state: RunnerTelemetryState,
  checkedAt: string,
): Promise<void> {
  const suffix = engine === ENGINE_CODEX ? '' : `_${engine}`;
  const owner=ownerRuntimeFor(db);
  if(owner){owner.assertOwner();const snapshot=owner.state.snapshot();const values=[{name:`runner_state${suffix}`,value:state},{name:`runner_last_check${suffix}`,value:checkedAt},{name:state==='ok'?`runner_last_ok${suffix}`:`runner_last_fail${suffix}`,value:checkedAt}];
    if(values.every(({name,value})=>{const prior=snapshot.settings.get(name);return prior&&(prior.updatedAt>checkedAt||prior.version===value&&prior.updatedAt===checkedAt);}))return;
  }
  if(owner){await mutateOwnerState(owner,{kind:'auth.runner.telemetry',payload:{engine,state,checkedAt},prepare(c){
    const values=[{name:`runner_state${suffix}`,version:state,updatedAt:checkedAt},{name:`runner_last_check${suffix}`,version:checkedAt,updatedAt:checkedAt},{name:state==='ok'?`runner_last_ok${suffix}`:`runner_last_fail${suffix}`,version:checkedAt,updatedAt:checkedAt}];
    for(const row of values){const prior=c.snapshot.table('versions').get(row.name);if(prior&&prior.updatedAt>checkedAt)continue;c.draft.upsert('versions',row);c.write(tx=>tx.insert(versions).values(row).onDuplicateKeyUpdate({set:{version:row.version,updatedAt:row.updatedAt}}));}return null;
  }});return;}

  await upsertVersion(db, `runner_state${suffix}`, state, checkedAt);
  await upsertVersion(db, `runner_last_check${suffix}`, checkedAt, checkedAt);
  await upsertVersion(
    db,
    state === 'ok' ? `runner_last_ok${suffix}` : `runner_last_fail${suffix}`,
    checkedAt,
    checkedAt,
  );
}

async function upsertVersion(db: Database, name: string, version: string, updatedAt: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO versions (name, version, updated_at)
    VALUES (${name}, ${version}, ${updatedAt})
    ON DUPLICATE KEY UPDATE version = VALUES(version), updated_at = VALUES(updated_at)
  `);
}

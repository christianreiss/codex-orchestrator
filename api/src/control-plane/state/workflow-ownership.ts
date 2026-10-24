import { sql } from 'drizzle-orm';
import type { PersistenceTransaction } from '../persistence.js';
/** Boot-only cutover: preserve existing exclusions; never infer completion from elapsed leases. */
export async function reconcileWorkflowOwnership(tx: PersistenceTransaction): Promise<void> {
  await tx.execute(
    sql`UPDATE workflow_run_tasks t LEFT JOIN agent_native_controls n ON n.session_id=t.claim_session_id AND n.binding_generation=t.claim_binding_generation SET t.claim_ownership_mode='connection',t.claim_native_instance_id=n.instance_id,t.claim_lease_until=NULL WHERE t.claim_owner_address_id IS NOT NULL AND t.claim_ownership_mode='timed'`,
  );
  await tx.execute(
    sql`UPDATE workflow_runs r LEFT JOIN workflow_run_members m ON m.run_id=r.id AND m.agent_address_id=r.coordinator_address_id AND m.status='active' LEFT JOIN agent_native_controls n ON n.session_id=m.session_id AND n.binding_generation=m.binding_generation SET r.coordinator_ownership_mode='connection',r.coordinator_session_id=m.session_id,r.coordinator_binding_generation=m.binding_generation,r.coordinator_native_instance_id=n.instance_id,r.coordinator_lease_until=NULL WHERE r.coordinator_address_id IS NOT NULL AND r.coordinator_ownership_mode='timed' AND r.status<>'completed'`,
  );
}

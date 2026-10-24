import {workflowState} from './workflows/owner.js';
import type {OwnerStateSnapshot} from '../control-plane/state/store.js';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { workflowRuns, workflowRunMembers, agentBusAddresses } from '../db/schema.js';
import { ConflictError, ForbiddenError } from '../http/errors.js';
import type { AgentSession } from '../db/schema.js';

type ReadDb = Pick<Database, 'select'>;
/** Shared resolver for bus groups, room chat and upload paths. Membership never comes from subscriptions. */
export function ownedWorkflowRunGroup(state:OwnerStateSnapshot,groupId:string){const run=state.table('workflowRuns').all().find(r=>r.communicationGroupId===groupId);if(!run)return null;return{run,members:state.table('workflowRunMembers').by('runId',run.id),closed:run.status==='completed'};}
export async function resolveWorkflowRunGroup(db: ReadDb, groupId: string, lock = false) {
  const state=workflowState(db as Database);if(state)return ownedWorkflowRunGroup(state,groupId);
  const query = db.select().from(workflowRuns).where(eq(workflowRuns.communicationGroupId, groupId)).limit(1);
  const [run] = lock ? await query.for('update') : await query;
  if (!run) return null;
  const roster = db.select().from(workflowRunMembers).where(eq(workflowRunMembers.runId, run.id));
  const members = lock ? await roster.for('update') : await roster;
  return { run, members, closed: run.status === 'completed' };
}
export async function assertWorkflowGroupAccess(db: ReadDb, groupId: string, session: AgentSession | null, write = false) {
  const managed = await resolveWorkflowRunGroup(db, groupId);
  if (!managed) return null;
  if (session) {
    const member = managed.members.find(m => m.agentAddressId === session.agentBusAddressId);
    if (!member || (write && (member.status !== 'active' || member.sessionId !== session.id || member.bindingGeneration !== session.bindingGeneration)))
      throw new ForbiddenError(write ? 'Active workflow run membership and binding required' : 'Workflow participant history required', 'workflow_member_required');
    if (write) {
      const state=workflowState(db as Database);
      const address=state?state.addresses.get(session.agentBusAddressId!):(await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id,session.agentBusAddressId!)).limit(1))[0];
      if (!address || address.currentSessionId !== session.id || address.bindingGeneration !== member.bindingGeneration)
        throw new ForbiddenError('Workflow participant binding is stale', 'workflow_member_required');
    }
  }
  if (write && managed.closed) throw new ConflictError('Workflow run communication is closed', 'workflow_group_closed');
  return managed;
}
export async function rejectManagedWorkflowGroupMutation(db: ReadDb, groupId: string) {
  if (await resolveWorkflowRunGroup(db, groupId))
    throw new ConflictError('Manage this group through its workflow run', 'workflow_group_managed');
}

/** Upload writes recheck membership under the bus lock, closing the access-check/finish race. */
export async function assertWorkflowAttachmentWrite(db: Pick<Database, 'select'>, roomId: string, owner: string) {
  const state=workflowState(db as Database);
  if(state){const managed=ownedWorkflowRunGroup(state,roomId);if(!managed)return;if(managed.closed)throw new ConflictError('Workflow run communication is closed','workflow_group_closed');if(owner.startsWith('room:agent:')){const id=owner.slice('room:agent:'.length),member=managed.members.find(m=>m.agentAddressId===id&&m.status==='active'),session=member?state.sessions.get(member.sessionId):undefined,address=state.addresses.get(id);if(!session||session.endedAt||session.bindingGeneration!==member?.bindingGeneration||session.agentBusAddressId!==id||!address||address.currentSessionId!==session.id||address.bindingGeneration!==member?.bindingGeneration)throw new ForbiddenError('Active workflow run membership required','workflow_member_required');}else if(!owner.startsWith('room:admin:'))throw new ForbiddenError('Workflow uploads require room access','workflow_member_required');return;}
  // Look up only to avoid changing locking behavior of ordinary conversations.
  if (!(await resolveWorkflowRunGroup(db, roomId))) return;
  const { versions, agentSessions, agentBusAddresses } = await import('../db/schema.js');
  await db.select().from(versions).where(eq(versions.name, 'agent_messaging_enabled')).for('update');
  // A locking read refreshes state even under MySQL REPEATABLE READ after the initial lookup.
  const managed = await resolveWorkflowRunGroup(db, roomId, true);
  if (!managed) return;
  if (managed.closed) throw new ConflictError('Workflow run communication is closed', 'workflow_group_closed');
  if (owner.startsWith('room:agent:')) {
    const addressId = owner.slice('room:agent:'.length);
    const member = managed.members.find(m => m.agentAddressId === addressId && m.status === 'active');
    const [session] = member ? await db.select().from(agentSessions).where(and(eq(agentSessions.id, member.sessionId), eq(agentSessions.agentBusAddressId, addressId))).limit(1).for('update') : [];
    const [address] = await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, addressId)).limit(1).for('update');
    if (!session || session.endedAt || session.bindingGeneration !== member?.bindingGeneration || !address || address.currentSessionId !== session.id || address.bindingGeneration !== member?.bindingGeneration)
      throw new ForbiddenError('Active workflow run membership required', 'workflow_member_required');
  } else if (!owner.startsWith('room:admin:')) {
    throw new ForbiddenError('Workflow uploads require room access', 'workflow_member_required');
  }
}

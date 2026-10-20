import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { workflowRuns, workflowRunMembers } from '../db/schema.js';
import { ConflictError, ForbiddenError } from '../http/errors.js';
import type { AgentSession } from '../db/schema.js';

type ReadDb = Pick<Database, 'select'>;
/** Shared resolver for bus groups, room chat and upload paths. Membership never comes from subscriptions. */
export async function resolveWorkflowRunGroup(db: ReadDb, groupId: string) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.communicationGroupId, groupId)).limit(1);
  if (!run) return null;
  const members = await db.select().from(workflowRunMembers).where(eq(workflowRunMembers.runId, run.id));
  return { run, members, closed: run.status === 'completed' };
}
export async function assertWorkflowGroupAccess(db: ReadDb, groupId: string, session: AgentSession | null, write = false) {
  const managed = await resolveWorkflowRunGroup(db, groupId);
  if (!managed) return null;
  if (session) {
    const member = managed.members.find(m => m.agentAddressId === session.agentBusAddressId);
    if (!member || (write && (member.status !== 'active' || member.sessionId !== session.id || member.bindingGeneration !== session.bindingGeneration)))
      throw new ForbiddenError(write ? 'Active workflow run membership and binding required' : 'Workflow participant history required', 'workflow_member_required');
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
  // Look up only to avoid changing locking behavior of ordinary conversations.
  if (!(await resolveWorkflowRunGroup(db, roomId))) return;
  const { versions, agentSessions } = await import('../db/schema.js');
  await db.select().from(versions).where(eq(versions.name, 'agent_messaging_enabled')).for('update');
  const managed = await resolveWorkflowRunGroup(db, roomId);
  if (!managed) return;
  if (managed.closed) throw new ConflictError('Workflow run communication is closed', 'workflow_group_closed');
  if (owner.startsWith('room:agent:')) {
    const addressId = owner.slice('room:agent:'.length);
    const member = managed.members.find(m => m.agentAddressId === addressId && m.status === 'active');
    const [session] = member ? await db.select().from(agentSessions).where(and(eq(agentSessions.id, member.sessionId), eq(agentSessions.agentBusAddressId, addressId))).limit(1) : [];
    if (!session || session.endedAt || session.bindingGeneration !== member?.bindingGeneration)
      throw new ForbiddenError('Active workflow run membership required', 'workflow_member_required');
  } else if (!owner.startsWith('room:admin:')) {
    throw new ForbiddenError('Workflow uploads require room access', 'workflow_member_required');
  }
}

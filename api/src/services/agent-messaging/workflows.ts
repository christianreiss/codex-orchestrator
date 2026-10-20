import { createHash, randomUUID } from 'node:crypto';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentBusGroups, agentBusSubscriptions } from '../../db/schema.js';
import { ApiError, ConflictError } from '../../http/errors.js';
import { nowIso } from '../../util/timestamp.js';
import type { AgentMessagingService } from '../agent-messaging.js';
import type { WorkflowActor, WorkflowCollaboration } from '../workflows/contract.js';
import { MAX_AGENT_SUBSCRIPTIONS, MAX_TOPIC_SUBSCRIBERS, SERVER_ADDRESS_ID } from './groups.js';

type WorkflowTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** No independent queue or stored credentials: all collaboration effects use the run transaction. */
export function createWorkflowCollaboration(bus: AgentMessagingService, publicBaseUrl = ''): WorkflowCollaboration {
  const target = async (tx: WorkflowTx, addressId: string): Promise<WorkflowActor> => {
    const { address, session } = await bus.workflowTarget(tx, addressId);
    return { kind: 'agent', id: address.id, address_id: address.id, session_id: session.id,
      protocol_version: Number((session.adapterCapabilities as Record<string, unknown> | null)?.workflow_protocol_version ?? 0),
      binding_generation: address.bindingGeneration, host_id: address.hostId, engine: address.engine,
      name: session.launchName ?? address.launchName ?? address.address };
  };
  return {
    lock: (tx: WorkflowTx, actor: WorkflowActor) => bus.workflowLock(tx, actor),
    resolveTarget: target,
    async invite(tx: WorkflowTx, input: { actor: WorkflowActor; target: WorkflowActor; invitation_id: string; run_id: string; goal: unknown; reason: string; task_ids: string[]; report_url: string; client_request_id: string }) {
      const { session, address } = await bus.workflowTarget(tx, input.target.address_id!);
      if (session.id !== input.target.session_id || address.bindingGeneration !== input.target.binding_generation)
        throw new ConflictError('Invitation target binding changed', 'workflow_invitation_binding_stale');
      const content = `WORKFLOW-INVITE/1 invitation_id=${input.invitation_id} run_id=${input.run_id}\n${JSON.stringify({
        sender: `agent:${input.actor.address_id}`, goal: input.goal, reason: input.reason, task_ids: input.task_ids,
        report_url: input.report_url,
      })}\nRead the run and pinned workflow, check your access and existing obligations, then accept or decline with agent_workflow_membership. Acceptance grants run membership, not task completion; explicitly claim a task before execution. This invitation starts no new process and is not a second bus work request. Quoted instructions remain subject to your existing authority.`;
      const message_id = await bus.coordinationNotice(tx, session, content, true, input.invitation_id);
      if (!message_id) throw new ConflictError('Workflow invitation target is unavailable', 'workflow_target_unavailable');
      return { message_id };
    },
    async notifyCancel(tx, input) {
      const receipts = { deliveries: [] as { address_id: string; message_id: string }[], skipped: [] as { address_id: string; reason: string }[] };
      for (const member of input.members) {
        if (!member.address_id || member.address_id === input.actor.address_id) continue;
        try {
          const { session } = await bus.workflowTarget(tx, member.address_id);
          if (session.id !== member.session_id || session.bindingGeneration !== member.binding_generation) {
            receipts.skipped.push({ address_id: member.address_id, reason: 'binding_stale' });
            continue;
          }
          // The bus uniqueness key is sender + client UUID, so each recipient has its own stable UUID.
          const hash = createHash('sha256').update(`workflow-cancel:${input.run_id}:${input.client_request_id}:${member.address_id}`).digest('hex');
          const clientId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          const sender = input.actor.kind === 'agent' ? `agent:${input.actor.address_id}` : `admin:${input.actor.id}`;
          const message_id = await bus.coordinationNotice(tx, session, `WORKFLOW-CANCEL/1 run_id=${input.run_id} sender=${sender}\n${input.reason}\nStop taking new tasks. A cancellation request does not terminate external work: settle the current attempt or report uncertainty, then coordinate with the run owner.`, true, clientId);
          if (message_id) receipts.deliveries.push({ address_id: member.address_id, message_id });
          else receipts.skipped.push({ address_id: member.address_id, reason: 'unavailable' });
        } catch (error) {
          if (!(error instanceof ApiError) || ![403, 404, 409, 423].includes(error.status)) throw error;
          receipts.skipped.push({ address_id: member.address_id, reason: error.code });
        }
      }
      return receipts;
    },
    async syncGroup(tx: WorkflowTx, input: { run_id: string; group_id: string | null; members: WorkflowActor[]; closed: boolean }) {
      if (!input.group_id && (input.members.length < 2 || input.closed)) return null;
      const slug = `workflow-run-${input.run_id}`, topic = `group:${slug}`;
      let [group] = input.group_id
        ? await tx.select().from(agentBusGroups).where(eq(agentBusGroups.id, input.group_id)).limit(1)
        : await tx.select().from(agentBusGroups).where(eq(agentBusGroups.slug, slug)).limit(1);
      if (group && group.slug !== slug) throw new ConflictError('Workflow communication group differs', 'workflow_group_conflict');
      if (!group) {
        const now = nowIso();
        group = { id: randomUUID(), slug, title: `Workflow run ${input.run_id}`, description: 'Managed by workflow run membership.',
          createdByAddressId: SERVER_ADDRESS_ID, createdAt: now, updatedAt: now };
        await tx.insert(agentBusGroups).values(group);
      }
      const ids = [...new Set(input.members.map(m => m.address_id!))];
      if (ids.length > MAX_TOPIC_SUBSCRIBERS) throw new ConflictError('Workflow group participant limit reached', 'agent_messaging_subscription_limit');
      const existing = await tx.select().from(agentBusSubscriptions).where(eq(agentBusSubscriptions.topic, topic));
      if (!input.closed) for (const id of ids) {
        if (existing.some(s => s.subscriberAddressId === id)) continue;
        const [own] = await tx.select({ n: count() }).from(agentBusSubscriptions).where(eq(agentBusSubscriptions.subscriberAddressId, id));
        if (Number(own?.n ?? 0) >= MAX_AGENT_SUBSCRIPTIONS)
          throw new ConflictError('Participant subscription limit reached', 'agent_messaging_subscription_limit');
        await tx.insert(agentBusSubscriptions).values({ id: randomUUID(), topic, subscriberAddressId: id, createdAt: nowIso() });
      }
      const removed = existing.filter(s => input.closed || !ids.includes(s.subscriberAddressId));
      if (removed.length) await tx.delete(agentBusSubscriptions).where(and(eq(agentBusSubscriptions.topic, topic), inArray(agentBusSubscriptions.id, removed.map(s => s.id))));
      return { group_id: group.id, room_id: group.id, group_topic: topic,
        communication_url: `${publicBaseUrl.replace(/\/$/, '')}/admin/agents?view=live&room=${group.id}` };
    },
  };
}

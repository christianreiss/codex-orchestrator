import { stageRoomEvent } from '../../control-plane/state/room-heads.js';
import { recordRoomChange } from '../agent-room-chat/changes.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ownerRuntimeFor,mutateOwnerState,addOwnerResponseProof,bindOwnerResponseRuntime,type OwnerMutationContext } from '../../control-plane/state/runtime.js';
import { ownedBridge,ownedAddress,requireOwnedMessaging } from '../../control-plane/state/messaging.js';
import { stageQueuedMessage,stageServerAddress } from '../../control-plane/state/messages.js';
import { stageDelete } from '../../control-plane/state/rows.js';
import type { Json } from '../../control-plane/commands.js';
const groupCommand=new AsyncLocalStorage<OwnerMutationContext>();
import type { MessagingHost } from './types.js';
import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  agentBusAddresses,
  agentBusConversations,
  agentBusGroups,
  agentBusMessages,
  agentBusPublications, agentRoomEvents,
  agentBusSubscriptions,
  agentSessions,
  type AgentBusAddress,
  type AgentSession,
  type Host,
} from '../../db/schema.js';
import {
  ApiError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../http/errors.js';
import { sha256 } from '../../security/hash.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import {
  normalizeMessageBody,
  normalizeMessageTtl,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeUuid,
} from './normalize.js';
import type { AgentMessagingDb } from './types.js';
import { resolveWorkflowRunGroup, rejectManagedWorkflowGroupMutation, ownedWorkflowRunGroup } from '../workflow-run-group.js';
import { receiverState } from '../agent-receiver-state.js';
import { queuePolicy, deliveryTimingReceipt } from './smart-queue.js';
import { newQueuedMessage } from './views.js';

export const SERVER_ADDRESS_ID = '00000000-0000-4000-8000-000000000001';
export const SERVER_PUBLICATION_TOPIC = `agent:${SERVER_ADDRESS_ID}`;
export const MAX_TOPIC_SUBSCRIBERS = 64;
export const MAX_AGENT_SUBSCRIPTIONS = 64;
export const MAX_PUBLICATIONS_PER_MINUTE = 30;
export const MAX_PUBLICATION_CONTENT_BYTES = 30 * 1024;

export function normalizeGroupSlug(value: string): string {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) {
    throw new ValidationError(
      'slug must contain 1–64 lowercase letters, digits, dots, underscores or hyphens',
      { param: 'slug' },
    );
  }
  return slug;
}

export function normalizePublicationTopic(value: string): string {
  const topic = String(value ?? '')
    .trim()
    .toLowerCase();
  if (topic.startsWith('group:')) return `group:${normalizeGroupSlug(topic.slice(6))}`;
  if (topic.startsWith('agent:')) return `agent:${normalizeUuid(topic.slice(6), 'topic')}`;
  throw new ValidationError('topic must be group:<slug> or agent:<address UUID>', { param: 'topic' });
}

interface GroupsCore {
  db: Database;
  keyring: Keyring;
  requireEnabledLocked(db: AgentMessagingDb): Promise<void>;
  authenticateBridge(sessionId: string, token: string): Promise<{ session: AgentSession; host: MessagingHost }>;
  requireAddressLocked(db: AgentMessagingDb, id: string): Promise<AgentBusAddress>;
  assertSessionAddressLocked(
    db: AgentMessagingDb,
    sessionId: string,
    address: AgentBusAddress,
  ): Promise<void>;
  assertAddressEligibleLocked(db: AgentMessagingDb, address: AgentBusAddress): Promise<void>;
}

type Group = typeof agentBusGroups.$inferSelect;
interface PublicationInput {
  topic: string;
  content: string;
  clientMessageId: string;
  ttlSeconds?: number | null;
  deliveryTiming?: 'immediate' | 'after_turn';
}
interface Receipts {
  deliveries: Array<{ address_id: string; message_id: string }>;
  skipped: Array<{ address_id: string; reason: string }>;
}

/** Opt-in routing only: a topic is never a tap into direct or conference traffic. */
export class AgentMessagingGroups {
  constructor(private readonly core: GroupsCore) {}
  private async managed(tx:AgentMessagingDb,id:string){const state=this.snapshot();return state?ownedWorkflowRunGroup(state,id):resolveWorkflowRunGroup(tx,id);}
  private async rejectManaged(tx:AgentMessagingDb,id:string){if(await this.managed(tx,id))throw new ConflictError('Manage this group through its workflow run','workflow_group_managed');}
  private snapshot(){const context=groupCommand.getStore();if(context)return context.draft.view();const owner=ownerRuntimeFor(this.core.db);owner?.assertOwner();return owner?.state.snapshot();}
  private async transaction<T>(action:(tx:AgentMessagingDb)=>Promise<T>):Promise<T>{const owner=ownerRuntimeFor(this.core.db);if(!owner)return this.core.db.transaction(action);if(groupCommand.getStore())return action(this.core.db);let value!:T;await mutateOwnerState(owner,{kind:'messaging.group.command',payload:{},authorize:requireOwnedMessaging,prepare:ctx=>groupCommand.run(ctx,async()=>{value=await action(this.core.db);return ()=>JSON.parse(JSON.stringify(value??null)) as Json;})});return value;}
  private async deleteSubscriptions(tx:AgentMessagingDb,rows:ReadonlyArray<typeof agentBusSubscriptions.$inferSelect>):Promise<void>{const ctx=groupCommand.getStore();if(ctx){for(const row of rows)stageDelete(ctx,'agentBusSubscriptions',row.id);return;}for(const row of rows)await tx.delete(agentBusSubscriptions).where(eq(agentBusSubscriptions.id,row.id));}
  private async conversation(tx:AgentMessagingDb,row:typeof agentBusConversations.$inferInsert):Promise<void>{const ctx=groupCommand.getStore();if(ctx){ctx.draft.upsert('agentBusConversations',{...row,lastToASequence:0,lastToBSequence:0} as typeof agentBusConversations.$inferSelect);ctx.write(async owned=>owned.insert(agentBusConversations).values(row));return;}await tx.insert(agentBusConversations).values(row);}
  private async queued(tx:AgentMessagingDb,row:typeof agentBusMessages.$inferInsert):Promise<void>{const ctx=groupCommand.getStore();if(ctx){stageQueuedMessage(ctx,row);return;}await tx.insert(agentBusMessages).values(row);}


  private async asAgent<T>(
    sessionId: string,
    token: string,
    action: (tx: AgentMessagingDb, actor: AgentBusAddress) => Promise<T>,
    readOnly=false,
  ): Promise<T> {
    const owner=ownerRuntimeFor(this.core.db);if(owner){const admit=(snapshot=owner.state.snapshot())=>{owner.assertOwner();const {session}=ownedBridge(snapshot,sessionId,token);if(!session.agentBusAddressId)throw new ConflictError('Agent session has no messaging address','agent_messaging_address_missing');const actor=ownedAddress(snapshot,session.agentBusAddressId);if(actor.currentSessionId!==session.id||actor.bindingGeneration!==session.bindingGeneration)throw new ConflictError('Agent binding changed','agent_binding_changed');return actor;};
      if(readOnly){
        bindOwnerResponseRuntime(owner);
        const actor=admit();
        const proof=(snapshot: Parameters<typeof ownedBridge>[0])=>{
          const current=admit(snapshot);
          if(current.id!==actor.id||current.bindingGeneration!==actor.bindingGeneration)
            throw new ConflictError('Agent binding changed','agent_binding_changed');
        };
        addOwnerResponseProof('messaging.group.read:'+sessionId,proof);
        const result=await action(this.core.db,actor);
        proof(owner.state.snapshot());
        return result;
      }
      let value!:T;await mutateOwnerState(owner,{kind:'messaging.group.command',principal:'session:'+sessionId,payload:{},authorize:()=>{admit();},prepare:ctx=>groupCommand.run(ctx,async()=>{value=await action(this.core.db,admit());return ()=>JSON.parse(JSON.stringify(value??null)) as Json;})});return value;}
    const auth = await this.core.authenticateBridge(sessionId, token);
    if (!auth.session.agentBusAddressId)
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    return this.transaction(async (tx) => {
      // Same lock as every bus mutation, serializing publication snapshots with
      // joins/leaves and the master switch, including zero-recipient publishes.
      await this.core.requireEnabledLocked(tx);
      const actor = await this.core.requireAddressLocked(tx, auth.session.agentBusAddressId!);
      await this.core.assertSessionAddressLocked(tx, sessionId, actor);
      return action(tx, actor);
    });
  }

  private async group(tx: AgentMessagingDb, slug: string): Promise<Group> {
    const rows = this.snapshot()?.table('agentBusGroups').all().filter(r=>r.slug===slug)??await tx.select().from(agentBusGroups).where(eq(agentBusGroups.slug,slug)).limit(1);
    if (!rows[0]) throw new NotFoundError('Group not found', 'agent_messaging_group_not_found');
    return rows[0];
  }

  private view(group: Group, memberCount = 0) {
    return {
      id: group.id,
      slug: group.slug,
      topic: `group:${group.slug}`,
      title: group.title,
      description: group.description,
      member_count: memberCount,
      created_at: group.createdAt,
      updated_at: group.updatedAt,
    };
  }

  private async list(tx: AgentMessagingDb) {
    const state=this.snapshot();const rows=state?[...state.table('agentBusGroups').all()].sort((a,b)=>a.slug.localeCompare(b.slug)):await tx.select().from(agentBusGroups).orderBy(asc(agentBusGroups.slug));
    const counts = state?rows.map(r=>({topic:'group:'+r.slug,value:state.table('agentBusSubscriptions').all().filter(s=>s.topic==='group:'+r.slug).length})):await tx
      .select({ topic: agentBusSubscriptions.topic, value: count() })
      .from(agentBusSubscriptions)
      .groupBy(agentBusSubscriptions.topic);
    return {
      groups: await Promise.all(rows.map(async row => {
        const managed = await this.managed(tx, row.id);
        return { ...this.view(row, Number(counts.find(c => c.topic === `group:${row.slug}`)?.value ?? 0)),
          ...(managed ? { workflow_managed: true, workflow_run_id: managed.run.id, workflow_report_url: `/admin/workflows/runs/${managed.run.id}`, status: managed.closed ? 'closed' : 'open' } : {}) };
      })),
      server_topic: SERVER_PUBLICATION_TOPIC,
      max_topic_subscribers: MAX_TOPIC_SUBSCRIBERS,
      max_agent_subscriptions: MAX_AGENT_SUBSCRIPTIONS,
      max_publication_content_bytes: MAX_PUBLICATION_CONTENT_BYTES,
    };
  }

  async listAdmin() {
    return this.list(this.core.db);
  }
  async listForAgent(sessionId: string, token: string) {
    return this.asAgent(sessionId, token, (tx) => this.list(tx),true);
  }

  private async create(
    tx: AgentMessagingDb,
    actorId: string,
    input: { slug: string; title: string; description?: string | null },
  ) {
    const slug = normalizeGroupSlug(input.slug);
    if (slug.startsWith('workflow-run-')) throw new ConflictError('Workflow group slugs are reserved', 'workflow_group_managed');
    const title = normalizeRequiredText(input.title, 'title', 120);
    const description = normalizeOptionalText(input.description, 1024);
    const existing=this.snapshot()?.table('agentBusGroups').all().filter(r=>r.slug===slug)??await tx.select().from(agentBusGroups).where(eq(agentBusGroups.slug,slug)).limit(1);
    if (existing[0]) {
      if (
        existing[0].createdByAddressId !== actorId ||
        existing[0].title !== title ||
        existing[0].description !== description
      ) {
        throw new ConflictError('Group slug is already in use', 'agent_messaging_group_conflict');
      }
      return { created: false, group: this.view(existing[0]) };
    }
    const state=this.snapshot();const owned=state?[{value:state.table('agentBusGroups').all().filter(g=>g.createdByAddressId===actorId&&!state.table('workflowRuns').all().some(r=>r.communicationGroupId===g.id&&r.status==='completed')).length}]:await tx
      .select({ value: count() })
      .from(agentBusGroups)
      .where(and(eq(agentBusGroups.createdByAddressId, actorId), sql`NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.communication_group_id = ${agentBusGroups.id} AND r.status = 'completed')`));
    if (Number(owned[0]?.value ?? 0) >= MAX_AGENT_SUBSCRIPTIONS)
      throw new ConflictError('Group creation limit reached', 'agent_messaging_group_limit');
    const now = nowIso();
    const group = {
      id: randomUUID(),
      slug,
      title,
      description,
      createdByAddressId: actorId,
      createdAt: now,
      updatedAt: now,
    };
    const ctx=groupCommand.getStore();if(ctx){ctx.draft.upsert('agentBusGroups',group);ctx.write(async owned=>owned.insert(agentBusGroups).values(group));}else await tx.insert(agentBusGroups).values(group);
    return { created: true, group: this.view(group) };
  }

  async createForAgent(
    sessionId: string,
    token: string,
    input: { slug: string; title: string; description?: string | null },
  ) {
    const result = await this.asAgent(sessionId, token, (tx, actor) => this.create(tx, actor.id, input));
    if (result.created) wsPublisher.publish('agent_messaging.groups.changed', { slug: result.group.slug });
    return result;
  }
  async createAdmin(input: { slug: string; title: string; description?: string | null }) {
    const result = await this.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      return this.create(tx, SERVER_ADDRESS_ID, input);
    });
    if (result.created) wsPublisher.publish('agent_messaging.groups.changed', { slug: result.group.slug });
    return result;
  }

  /**
   * Hard delete that frees the slug for reuse. Fails closed while anyone other
   * than the actor is still subscribed; the actor's own opt-in (if any) goes
   * with the group. Past publications and queued deliveries are history and
   * keep their lifecycle. `actorId` null is the operator, who holds no
   * subscription and may remove any empty group.
   */
  private async remove(tx: AgentMessagingDb, actorId: string | null, rawSlug: string) {
    const group = await this.group(tx, normalizeGroupSlug(rawSlug));
    await this.rejectManaged(tx, group.id);
    if (actorId !== null && group.createdByAddressId !== actorId)
      throw new ForbiddenError(
        'Only the agent that created a group may delete it',
        'agent_messaging_group_forbidden',
      );
    // A retired member can never unsubscribe itself; reclaim it first so a
    // dead host cannot make a short-lived group undeletable.
    await this.pruneRetiredSubscriptions(tx);
    const topic = `group:${group.slug}`;
    const members=this.snapshot()?.table('agentBusSubscriptions').all().filter(r=>r.topic===topic)??await tx
      .select({ subscriberAddressId: agentBusSubscriptions.subscriberAddressId })
      .from(agentBusSubscriptions)
      .where(eq(agentBusSubscriptions.topic, topic));
    const others = members.filter((row) => row.subscriberAddressId !== actorId).length;
    if (others > 0)
      throw new ConflictError(
        `Group still has ${others} other member${others === 1 ? '' : 's'}; they must unsubscribe first`,
        'agent_messaging_group_members_remain',
        { member_count: others },
      );
    const ctx=groupCommand.getStore();if(ctx){await this.deleteSubscriptions(tx,ctx.draft.table('agentBusSubscriptions').all().filter(r=>r.topic===topic));stageDelete(ctx,'agentBusGroups',group.id);}else{await tx.delete(agentBusSubscriptions).where(eq(agentBusSubscriptions.topic,topic));await tx.delete(agentBusGroups).where(eq(agentBusGroups.id,group.id));}
    return {
      deleted: true as const,
      slug: group.slug,
      topic,
      unsubscribed: members.length > 0,
      group: this.view(group, 0),
    };
  }

  private announceRemoval(result: Awaited<ReturnType<AgentMessagingGroups['remove']>>) {
    wsPublisher.publish('agent_messaging.groups.changed', { slug: result.slug });
    if (result.unsubscribed)
      wsPublisher.publish('agent_messaging.subscriptions.changed', { topic: result.topic });
    return result;
  }
  async deleteForAgent(sessionId: string, token: string, slug: string) {
    return this.announceRemoval(
      await this.asAgent(sessionId, token, (tx, actor) => this.remove(tx, actor.id, slug)),
    );
  }
  async deleteAdmin(slug: string) {
    return this.announceRemoval(
      await this.transaction(async (tx) => {
        await this.core.requireEnabledLocked(tx);
        return this.remove(tx, null, slug);
      }),
    );
  }

  private async detail(tx: AgentMessagingDb, rawSlug: string) {
    const group = await this.group(tx, normalizeGroupSlug(rawSlug));
    const state=this.snapshot();const rows=state?state.table('agentBusSubscriptions').all().filter(r=>r.topic==='group:'+group.slug).flatMap(subscription=>{const address=state.addresses.get(subscription.subscriberAddressId);return address?[{subscription,address}]:[];}).sort((a,b)=>a.subscription.createdAt.localeCompare(b.subscription.createdAt)):await tx
      .select({ subscription: agentBusSubscriptions, address: agentBusAddresses })
      .from(agentBusSubscriptions)
      .innerJoin(agentBusAddresses, eq(agentBusAddresses.id, agentBusSubscriptions.subscriberAddressId))
      .where(eq(agentBusSubscriptions.topic, `group:${group.slug}`))
      .orderBy(asc(agentBusSubscriptions.createdAt));
    const managed = await this.managed(tx, group.id);
    return {
      group: { ...this.view(group, rows.length), ...(managed ? { workflow_managed: true, workflow_run_id: managed.run.id, workflow_report_url: `/admin/workflows/runs/${managed.run.id}`, status: managed.closed ? 'closed' : 'open' } : {}) },
      members: rows.map(({ subscription, address }) => ({
        address_id: address.id,
        address: address.address,
        alias: address.displayAlias,
        engine: address.engine,
        host_id: address.hostId,
        joined_at: subscription.createdAt,
      })),
    };
  }
  async detailAdmin(slug: string) {
    return this.detail(this.core.db, slug);
  }
  async detailForAgent(sessionId: string, token: string, slug: string) {
    return this.asAgent(sessionId, token, (tx) => this.detail(tx, slug),true);
  }

  private async requireTopic(tx: AgentMessagingDb, topic: string) {
    if (topic.startsWith('group:')) await this.group(tx, topic.slice(6));
    else if (topic !== SERVER_PUBLICATION_TOPIC) {
      const address = await this.core.requireAddressLocked(tx, topic.slice(6));
      await this.core.assertAddressEligibleLocked(tx, address);
    }
  }

  private async pruneRetiredSubscriptions(tx: AgentMessagingDb): Promise<void> {
    const ctx=groupCommand.getStore();if(ctx){const state=ctx.draft.view(),alive=(id:string)=>{const a=state.addresses.get(id);return a&&!a.archivedAt&&state.hosts.has(a.hostId);};await this.deleteSubscriptions(tx,state.table('agentBusSubscriptions').all().filter(r=>!alive(r.subscriberAddressId)||r.topic.startsWith('agent:')&&r.topic!==SERVER_PUBLICATION_TOPIC&&!alive(r.topic.slice(6))));return;}
    // Disable, suspension and offline state preserve opt-in. Only permanent
    // retirement may reclaim capacity; a retired agent cannot opt out itself.
    await tx.delete(agentBusSubscriptions).where(sql`
      NOT EXISTS (
        SELECT 1 FROM agent_bus_addresses AS subscriber
        INNER JOIN hosts AS subscriber_host ON subscriber_host.id = subscriber.host_id
        WHERE subscriber.id = ${agentBusSubscriptions.subscriberAddressId}
          AND subscriber.archived_at IS NULL
      ) OR (
        ${agentBusSubscriptions.topic} LIKE 'agent:%'
        AND ${agentBusSubscriptions.topic} <> ${SERVER_PUBLICATION_TOPIC}
        AND NOT EXISTS (
          SELECT 1 FROM agent_bus_addresses AS publisher
          INNER JOIN hosts AS publisher_host ON publisher_host.id = publisher.host_id
          WHERE publisher.id = SUBSTRING(${agentBusSubscriptions.topic}, 7)
            AND publisher.archived_at IS NULL
        )
      )
    `);
  }

  async subscribe(sessionId: string, token: string, rawTopic: string, subscribed: boolean) {
    const topic = normalizePublicationTopic(rawTopic);
    const result = await this.asAgent(sessionId, token, async (tx, actor) => {
      if (topic.startsWith('group:')) {
        const group = await this.group(tx, topic.slice(6));
        await this.rejectManaged(tx, group.id);
      }
      // Leaving remains possible when the followed agent is retired or disabled.
      if (subscribed) await this.requireTopic(tx, topic);
      if (subscribed) await this.pruneRetiredSubscriptions(tx);
      if (subscribed && topic === `agent:${actor.id}`)
        throw new ValidationError('An agent cannot subscribe to its own feed', { param: 'topic' });
      const predicate = and(
        eq(agentBusSubscriptions.topic, topic),
        eq(agentBusSubscriptions.subscriberAddressId, actor.id),
      );
      const state=this.snapshot();const existing=state?state.table('agentBusSubscriptions').all().filter(r=>r.topic===topic&&r.subscriberAddressId===actor.id):await tx.select().from(agentBusSubscriptions).where(predicate).limit(1);
      if (!subscribed) {
        await this.deleteSubscriptions(tx,existing);
        return { topic, subscribed: false, changed: existing.length > 0 };
      }
      if (existing[0]) return { topic, subscribed: true, changed: false };
      const [members,own]=state?[[{value:state.table('agentBusSubscriptions').all().filter(r=>r.topic===topic).length}],[{value:state.table('agentBusSubscriptions').all().filter(r=>r.subscriberAddressId===actor.id).length}]]:await Promise.all([
        tx
          .select({ value: count() })
          .from(agentBusSubscriptions)
          .where(eq(agentBusSubscriptions.topic, topic)),
        tx
          .select({ value: count() })
          .from(agentBusSubscriptions)
          .where(eq(agentBusSubscriptions.subscriberAddressId, actor.id)),
      ]);
      if (
        Number(members[0]?.value ?? 0) >= MAX_TOPIC_SUBSCRIBERS ||
        Number(own[0]?.value ?? 0) >= MAX_AGENT_SUBSCRIPTIONS
      ) {
        throw new ConflictError('Subscription limit reached', 'agent_messaging_subscription_limit');
      }
      const row={id:randomUUID(),topic,subscriberAddressId:actor.id,createdAt:nowIso()},ctx=groupCommand.getStore();if(ctx){ctx.draft.upsert('agentBusSubscriptions',row);ctx.write(async owned=>owned.insert(agentBusSubscriptions).values(row));}else await tx.insert(agentBusSubscriptions).values(row);
      return { topic, subscribed: true, changed: true };
    });
    if (result.changed) wsPublisher.publish('agent_messaging.subscriptions.changed', { topic });
    return result;
  }

  private async subscriptions(tx: AgentMessagingDb, subscriberId?: string) {
    const state=this.snapshot();const rows=state?state.table('agentBusSubscriptions').all().filter(r=>!subscriberId||r.subscriberAddressId===subscriberId).flatMap(subscription=>{const address=state.addresses.get(subscription.subscriberAddressId);return address?[{subscription,address}]:[];}).sort((a,b)=>a.subscription.topic.localeCompare(b.subscription.topic)):await tx
      .select({ subscription: agentBusSubscriptions, address: agentBusAddresses })
      .from(agentBusSubscriptions)
      .innerJoin(agentBusAddresses, eq(agentBusAddresses.id, agentBusSubscriptions.subscriberAddressId))
      .where(subscriberId ? eq(agentBusSubscriptions.subscriberAddressId, subscriberId) : undefined)
      .orderBy(asc(agentBusSubscriptions.topic));
    return {
      subscriptions: rows.map(({ subscription, address }) => ({
        topic: subscription.topic,
        subscriber_address_id: address.id,
        subscriber_address: address.address,
        subscriber_engine: address.engine,
        created_at: subscription.createdAt,
      })),
    };
  }
  async subscriptionsAdmin() {
    return this.subscriptions(this.core.db);
  }
  async subscriptionsForAgent(sessionId: string, token: string) {
    return this.asAgent(sessionId, token, (tx, actor) => this.subscriptions(tx, actor.id),true);
  }

  async server(tx: AgentMessagingDb): Promise<AgentBusAddress> {
    const ctx=groupCommand.getStore();if(ctx)return stageServerAddress(ctx,nowIso());const state=this.snapshot();if(state){const row=state.addresses.get(SERVER_ADDRESS_ID);if(!row)throw new Error('Reserved Server identity is absent outside owner command');return row;}
    const rows = await tx
      .select()
      .from(agentBusAddresses)
      .where(eq(agentBusAddresses.id, SERVER_ADDRESS_ID))
      .limit(1);
    if (rows[0]) {
      if (
        rows[0].engine !== 'server' ||
        rows[0].hostId !== 0 ||
        rows[0].currentSessionId !== null ||
        rows[0].enabled !== 1 ||
        rows[0].archivedAt !== null
      )
        throw new ConflictError(
          'Reserved Server identity conflicts',
          'agent_messaging_server_identity_conflict',
        );
      return rows[0];
    }
    const now = nowIso();
    await tx.insert(agentBusAddresses).values({
      id: SERVER_ADDRESS_ID,
      address: SERVER_PUBLICATION_TOPIC,
      displayAlias: null,
      hostId: 0,
      engine: 'server',
      username: 'Server',
      cwd: '/',
      cwdHash: sha256('/'),
      continuity: 'server',
      readiness: 'offline',
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return this.core.requireAddressLocked(tx, SERVER_ADDRESS_ID);
  }

  private async timingReceipts(tx: AgentMessagingDb, receipts: Receipts, timing: 'immediate' | 'after_turn') {
    const snapshot = this.snapshot();
    const deliveries = await Promise.all(receipts.deliveries.map(async delivery => {
      let capable = false;
      if (timing === 'immediate') {
        const address = snapshot ? snapshot.addresses.get(delivery.address_id) : (await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, delivery.address_id)))[0];
        if (address?.currentSessionId) {
          const session = snapshot ? snapshot.sessions.get(address.currentSessionId) : (await tx.select().from(agentSessions).where(eq(agentSessions.id, address.currentSessionId)))[0];
          capable = receiverState(session?.receiver)?.delivery_timing_v1 === true;
        }
      }
      return { ...delivery, ...deliveryTimingReceipt(timing, capable) };
    }));
    return { ...receipts, deliveries };
  }
  private async publish(
    tx: AgentMessagingDb,
    sender: AgentBusAddress,
    sessionId: string | null,
    input: PublicationInput,
  ) {
    const topic = normalizePublicationTopic(input.topic);
    const content = normalizeMessageBody(input.content);
    if (Buffer.byteLength(content, 'utf8') > MAX_PUBLICATION_CONTENT_BYTES) {
      throw new ValidationError(`Publication content exceeds ${MAX_PUBLICATION_CONTENT_BYTES} UTF-8 bytes`, {
        param: 'content',
      });
    }
    const ttl = normalizeMessageTtl(input.ttlSeconds);
    const clientId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const deliveryTiming = queuePolicy({ delivery_timing: input.deliveryTiming }).deliveryTiming;
    const digest = sha256(JSON.stringify({ topic, content, ttl, ...(deliveryTiming === 'immediate' ? { deliveryTiming } : {}) }));
    const existing=this.snapshot()?.table('agentBusPublications').all().filter(r=>r.senderAddressId===sender.id&&r.clientMessageId===clientId)??await tx
      .select()
      .from(agentBusPublications)
      .where(
        and(
          eq(agentBusPublications.senderAddressId, sender.id),
          eq(agentBusPublications.clientMessageId, clientId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].payloadSha256 !== digest)
        throw new ConflictError('Publication retry payload differs', 'agent_messaging_publication_conflict');
      const receipts = existing[0].receipts as Receipts;
      return {
        requested_delivery_timing: deliveryTiming,
        publication_id: existing[0].id,
        topic,
        created: false,
        recipient_count: receipts.deliveries.length,
        ...await this.timingReceipts(tx, receipts, deliveryTiming),
      };
    }
    await this.requireTopic(tx, topic);
    if (topic.startsWith('group:')) {
      const group = await this.group(tx, topic.slice(6));
      const managed = await this.managed(tx, group.id);
      if (managed && (managed.closed || (sender.id !== SERVER_ADDRESS_ID && !managed.members.some(m => m.status === 'active' && m.agentAddressId === sender.id && m.sessionId === sessionId && m.bindingGeneration === sender.bindingGeneration))))
        throw new ForbiddenError('Active workflow membership is required to publish', 'workflow_member_required');
    }
    if (topic.startsWith('agent:')) {
      if (topic !== `agent:${sender.id}`)
        throw new ForbiddenError(
          'Only the agent owning a feed may publish to it',
          'agent_messaging_publication_forbidden',
        );
    } else if (sender.id !== SERVER_ADDRESS_ID) {
      const joined=this.snapshot()?.table('agentBusSubscriptions').all().filter(r=>r.topic===topic&&r.subscriberAddressId===sender.id)??await tx
        .select()
        .from(agentBusSubscriptions)
        .where(
          and(
            eq(agentBusSubscriptions.topic, topic),
            eq(agentBusSubscriptions.subscriberAddressId, sender.id),
          ),
        )
        .limit(1);
      if (!joined[0])
        throw new ForbiddenError(
          'Subscribe to a group before publishing',
          'agent_messaging_group_membership_required',
        );
    }
    const state=this.snapshot();const recent=state?[{value:state.table('agentBusPublications').all().filter(r=>r.senderAddressId===sender.id&&Date.parse(r.createdAt)>=Date.now()-60000).length}]:await tx
      .select({ value: count() })
      .from(agentBusPublications)
      .where(
        and(
          eq(agentBusPublications.senderAddressId, sender.id),
          gte(agentBusPublications.createdAt, isoOffsetSeconds(-60)),
        ),
      );
    if (Number(recent[0]?.value ?? 0) >= MAX_PUBLICATIONS_PER_MINUTE)
      throw new ApiError('Publication rate limit reached', {
        status: 429,
        code: 'agent_messaging_publication_rate_limited',
        headers: { 'retry-after': '60' },
      });
    const subscribers=state?[...state.table('agentBusSubscriptions').all()].filter(r=>r.topic===topic).sort((a,b)=>a.subscriberAddressId.localeCompare(b.subscriberAddressId)):await tx
      .select()
      .from(agentBusSubscriptions)
      .where(eq(agentBusSubscriptions.topic, topic))
      .orderBy(asc(agentBusSubscriptions.subscriberAddressId));
    const publicationId = randomUUID();
    const now = nowIso();
    const receipts: Receipts = { deliveries: [], skipped: [] };
    // The trusted header makes this an explicit publication. It does not turn
    // any text from a peer or a Server admin into a new grant of authority.
    const body = normalizeMessageBody(
      `PUBLICATION/1 topic=${topic} publication_id=${publicationId}\nInformational publication; no reply required.\n\n${content}`,
    );
    for (const subscription of subscribers) {
      // A publisher never receives its own copy, but says so: without this a
      // sole-subscriber publish was indistinguishable from an empty audience.
      // An own feed cannot carry this row, since self-follow is refused.
      if (subscription.subscriberAddressId === sender.id) {
        receipts.skipped.push({ address_id: sender.id, reason: 'sender' });
        continue;
      }
      let target: AgentBusAddress;
      try {
        target = await this.core.requireAddressLocked(tx, subscription.subscriberAddressId);
        await this.core.assertAddressEligibleLocked(tx, target);
      } catch (error) {
        // Subscriptions survive temporary host ineligibility. Skip that target,
        // while propagating owner fences and unrelated authorization failures.
        if (
          !(error instanceof NotFoundError) &&
          !(error instanceof ForbiddenError && error.code === 'agent_messaging_host_ineligible')
        ) throw error;
        receipts.skipped.push({ address_id: subscription.subscriberAddressId, reason: 'address_ineligible' });
        continue;
      }
      const conversationId = randomUUID();
      await this.conversation(tx,{
        id: conversationId,
        addressAId: sender.id,
        addressBId: target.id,
        createdByAddressId: sender.id,
        nextSequence: 2,
        status: 'open',
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const messageId = randomUUID();
      await this.queued(tx,
        newQueuedMessage({
          id: messageId,
          conversationId,
          sequence: 1,
          sender,
          senderSessionId: sessionId,
          target,
          kind: 'publication',
          deliveryTiming,
          content: body,
          contentEnc: encrypt(body, this.core.keyring),
          clientMessageId: randomUUID(),
          expiresAt: isoOffsetSeconds(ttl),
          now,
        }),
      );
      receipts.deliveries.push({ address_id: target.id, message_id: messageId });
    }
    if (topic.startsWith('group:')) {
      const group=await this.group(tx,topic.slice(6));
      if(group){const event={id:publicationId,roomId:group.id,actor:`agent:${sender.id}`,requestId:clientId,payloadHash:digest,bodyEnc:encrypt(JSON.stringify({name:sender.launchName??sender.displayAlias??sender.username,content,attachments:[],kind:'publication'}),this.core.keyring),createdAt:now},ctx=groupCommand.getStore();if(ctx){stageRoomEvent(ctx,event);}else{await tx.insert(agentRoomEvents).values(event);await recordRoomChange(tx,group.id,'event',publicationId,now);}}
    }
    const publication={
      id: publicationId,
      topic,
      senderAddressId: sender.id,
      clientMessageId: clientId,
      payloadSha256: digest,
      contentBytes: Buffer.byteLength(content, 'utf8'),
      ttlSeconds: ttl,
      receipts,
      createdAt: now,
    };const ctx=groupCommand.getStore();if(ctx){ctx.draft.upsert('agentBusPublications',publication);ctx.write(async owned=>owned.insert(agentBusPublications).values(publication));}else await tx.insert(agentBusPublications).values(publication);
    return {
      requested_delivery_timing: deliveryTiming,
      publication_id: publicationId,
      topic,
      created: true,
      recipient_count: receipts.deliveries.length,
      ...await this.timingReceipts(tx, receipts, deliveryTiming),
    };
  }

  private notify(result: Awaited<ReturnType<AgentMessagingGroups['publish']>>) {
    if (result.created) {
      for (const delivery of result.deliveries)
        wsPublisher.publish('agent_messaging.message.changed', {
          message_id: delivery.message_id,
          status: 'queued',
        });
    }
    return result;
  }
  async publishForAgent(sessionId: string, token: string, input: PublicationInput) {
    input = { ...input };
    return this.notify(
      await this.asAgent(sessionId, token, (tx, sender) => this.publish(tx, sender, sessionId, input)),
    );
  }
  /**
   * A Server-originated informational notice to named addresses, outside any
   * topic: the role system's ROLE-UPDATE / ROLE-REVIEW / ROLE-PROPOSAL lines.
   * The body carries its own protocol header; ineligible addresses are skipped.
   */
  async noticeAddressesOwned(context:OwnerMutationContext,addressIds:string[],content:string,noticeId?:string){return groupCommand.run(context,()=>this.noticeAddresses(addressIds,content,noticeId));}
  async noticeAddresses(addressIds: string[], content: string, noticeId?: string) {
    const body = normalizeMessageBody(content);
    const roleWithdrawal = /^ROLE-UPDATE\/1 [^\n]* severity=withdrawn(?:\n|$)/.test(body);
    const result = await this.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const sender = await this.server(tx);
      const now = nowIso();
      const receipts: Receipts = { deliveries: [], skipped: [] };
      for (const id of [...new Set(addressIds)]) {
        let target: AgentBusAddress;
        try {
          target = await this.core.requireAddressLocked(tx, id);
          await this.core.assertAddressEligibleLocked(tx, target);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          receipts.skipped.push({ address_id: id, reason: 'address_ineligible' });
          continue;
        }
        if (roleWithdrawal) {
          const [session] = target.currentSessionId
            // The address lock fences binding/finish cleanup. Do not take the
            // session lock after it: finishSession locks session then address.
            ? this.snapshot()?[this.snapshot()!.sessions.get(target.currentSessionId)].filter(s=>s!==undefined):await tx.select().from(agentSessions).where(eq(agentSessions.id,target.currentSessionId))
            : [];
          if (!session || session.endedAt || session.agentBusAddressId !== target.id || session.bindingGeneration !== target.bindingGeneration) {
            receipts.skipped.push({ address_id: id, reason: 'session_ineligible' });
            continue;
          }
        }
        if (noticeId) {
          const known=this.snapshot()?.messages.all().find(m=>m.senderAddressId===sender.id&&m.targetAddressId===target.id&&m.clientMessageId===noticeId);
          const [existing] = known?[known]:await tx.select({ id: agentBusMessages.id }).from(agentBusMessages).where(and(
            eq(agentBusMessages.senderAddressId, sender.id), eq(agentBusMessages.targetAddressId, target.id),
            eq(agentBusMessages.clientMessageId, noticeId),
          )).limit(1);
          if (existing) { receipts.deliveries.push({ address_id: id, message_id: existing.id }); continue; }
        }
        const conversationId = randomUUID();
        await this.conversation(tx,{
          id: conversationId,
          addressAId: sender.id,
          addressBId: target.id,
          createdByAddressId: sender.id,
          nextSequence: 2,
          status: 'open',
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        });
        const messageId = randomUUID();
        const message = newQueuedMessage({
            id: messageId,
            conversationId,
            sequence: 1,
            sender,
            senderSessionId: null,
            target,
            kind: noticeId || roleWithdrawal ? 'presence_notice' : 'publication',
            content: body,
            contentEnc: encrypt(body, this.core.keyring),
            clientMessageId: noticeId ?? randomUUID(),
            expiresAt: isoOffsetSeconds(7 * 86400),
            now,
          });
        if (noticeId || roleWithdrawal) message.targetSessionId = target.currentSessionId;
        if (roleWithdrawal) {
          message.targetBindingGeneration = target.bindingGeneration;
          message.deliveryClass = 'coordination';
        }
        await this.queued(tx,message);
        receipts.deliveries.push({ address_id: target.id, message_id: messageId });
      }
      return receipts;
    });
    if(!groupCommand.getStore())for (const delivery of result.deliveries)
      wsPublisher.publish('agent_messaging.message.changed', { message_id: delivery.message_id, status: 'queued' });
    return result;
  }

  async publishAdmin(input: PublicationInput) {
    input = { ...input };
    return this.notify(
      await this.transaction(async (tx) => {
        await this.core.requireEnabledLocked(tx);
        return this.publish(tx, await this.server(tx), null, input);
      }),
    );
  }
}

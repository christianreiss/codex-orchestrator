import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  agentBusAddresses,
  agentBusConversations,
  agentBusGroups,
  agentBusMessages,
  agentBusPublications,
  agentBusSubscriptions,
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
  authenticateBridge(sessionId: string, token: string): Promise<{ session: AgentSession; host: Host }>;
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
}
interface Receipts {
  deliveries: Array<{ address_id: string; message_id: string }>;
  skipped: Array<{ address_id: string; reason: string }>;
}

/** Opt-in routing only: a topic is never a tap into direct or conference traffic. */
export class AgentMessagingGroups {
  constructor(private readonly core: GroupsCore) {}

  private async asAgent<T>(
    sessionId: string,
    token: string,
    action: (tx: AgentMessagingDb, actor: AgentBusAddress) => Promise<T>,
  ): Promise<T> {
    const auth = await this.core.authenticateBridge(sessionId, token);
    if (!auth.session.agentBusAddressId)
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    return this.core.db.transaction(async (tx) => {
      // Same lock as every bus mutation, serializing publication snapshots with
      // joins/leaves and the master switch, including zero-recipient publishes.
      await this.core.requireEnabledLocked(tx);
      const actor = await this.core.requireAddressLocked(tx, auth.session.agentBusAddressId!);
      await this.core.assertSessionAddressLocked(tx, sessionId, actor);
      return action(tx, actor);
    });
  }

  private async group(tx: AgentMessagingDb, slug: string): Promise<Group> {
    const rows = await tx.select().from(agentBusGroups).where(eq(agentBusGroups.slug, slug)).limit(1);
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
    const rows = await tx.select().from(agentBusGroups).orderBy(asc(agentBusGroups.slug));
    const counts = await tx
      .select({ topic: agentBusSubscriptions.topic, value: count() })
      .from(agentBusSubscriptions)
      .groupBy(agentBusSubscriptions.topic);
    return {
      groups: rows.map((row) =>
        this.view(row, Number(counts.find((c) => c.topic === `group:${row.slug}`)?.value ?? 0)),
      ),
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
    return this.asAgent(sessionId, token, (tx) => this.list(tx));
  }

  private async create(
    tx: AgentMessagingDb,
    actorId: string,
    input: { slug: string; title: string; description?: string | null },
  ) {
    const slug = normalizeGroupSlug(input.slug);
    const title = normalizeRequiredText(input.title, 'title', 120);
    const description = normalizeOptionalText(input.description, 1024);
    const existing = await tx.select().from(agentBusGroups).where(eq(agentBusGroups.slug, slug)).limit(1);
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
    const owned = await tx
      .select({ value: count() })
      .from(agentBusGroups)
      .where(eq(agentBusGroups.createdByAddressId, actorId));
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
    await tx.insert(agentBusGroups).values(group);
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
    const result = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      return this.create(tx, SERVER_ADDRESS_ID, input);
    });
    if (result.created) wsPublisher.publish('agent_messaging.groups.changed', { slug: result.group.slug });
    return result;
  }

  private async detail(tx: AgentMessagingDb, rawSlug: string) {
    const group = await this.group(tx, normalizeGroupSlug(rawSlug));
    const rows = await tx
      .select({ subscription: agentBusSubscriptions, address: agentBusAddresses })
      .from(agentBusSubscriptions)
      .innerJoin(agentBusAddresses, eq(agentBusAddresses.id, agentBusSubscriptions.subscriberAddressId))
      .where(eq(agentBusSubscriptions.topic, `group:${group.slug}`))
      .orderBy(asc(agentBusSubscriptions.createdAt));
    return {
      group: this.view(group, rows.length),
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
    return this.asAgent(sessionId, token, (tx) => this.detail(tx, slug));
  }

  private async requireTopic(tx: AgentMessagingDb, topic: string) {
    if (topic.startsWith('group:')) await this.group(tx, topic.slice(6));
    else if (topic !== SERVER_PUBLICATION_TOPIC) {
      const address = await this.core.requireAddressLocked(tx, topic.slice(6));
      await this.core.assertAddressEligibleLocked(tx, address);
    }
  }

  private async pruneRetiredSubscriptions(tx: AgentMessagingDb): Promise<void> {
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
      // Leaving remains possible when the followed agent is retired or disabled.
      if (subscribed) await this.requireTopic(tx, topic);
      if (subscribed) await this.pruneRetiredSubscriptions(tx);
      if (subscribed && topic === `agent:${actor.id}`)
        throw new ValidationError('An agent cannot subscribe to its own feed', { param: 'topic' });
      const predicate = and(
        eq(agentBusSubscriptions.topic, topic),
        eq(agentBusSubscriptions.subscriberAddressId, actor.id),
      );
      const existing = await tx.select().from(agentBusSubscriptions).where(predicate).limit(1);
      if (!subscribed) {
        await tx.delete(agentBusSubscriptions).where(predicate);
        return { topic, subscribed: false, changed: existing.length > 0 };
      }
      if (existing[0]) return { topic, subscribed: true, changed: false };
      const [members, own] = await Promise.all([
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
      await tx
        .insert(agentBusSubscriptions)
        .values({ id: randomUUID(), topic, subscriberAddressId: actor.id, createdAt: nowIso() });
      return { topic, subscribed: true, changed: true };
    });
    if (result.changed) wsPublisher.publish('agent_messaging.subscriptions.changed', { topic });
    return result;
  }

  private async subscriptions(tx: AgentMessagingDb, subscriberId?: string) {
    const rows = await tx
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
    return this.asAgent(sessionId, token, (tx, actor) => this.subscriptions(tx, actor.id));
  }

  private async server(tx: AgentMessagingDb): Promise<AgentBusAddress> {
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
    const digest = sha256(JSON.stringify({ topic, content, ttl }));
    const existing = await tx
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
        publication_id: existing[0].id,
        topic,
        created: false,
        recipient_count: receipts.deliveries.length,
        ...receipts,
      };
    }
    await this.requireTopic(tx, topic);
    if (topic.startsWith('agent:')) {
      if (topic !== `agent:${sender.id}`)
        throw new ForbiddenError(
          'Only the agent owning a feed may publish to it',
          'agent_messaging_publication_forbidden',
        );
    } else if (sender.id !== SERVER_ADDRESS_ID) {
      const joined = await tx
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
    const recent = await tx
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
    const subscribers = await tx
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
      if (subscription.subscriberAddressId === sender.id) continue;
      let target: AgentBusAddress;
      try {
        target = await this.core.requireAddressLocked(tx, subscription.subscriberAddressId);
        await this.core.assertAddressEligibleLocked(tx, target);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        receipts.skipped.push({ address_id: subscription.subscriberAddressId, reason: 'address_ineligible' });
        continue;
      }
      const conversationId = randomUUID();
      await tx.insert(agentBusConversations).values({
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
      await tx.insert(agentBusMessages).values(
        newQueuedMessage({
          id: messageId,
          conversationId,
          sequence: 1,
          sender,
          senderSessionId: sessionId,
          target,
          kind: 'publication',
          content: body,
          contentEnc: encrypt(body, this.core.keyring),
          clientMessageId: randomUUID(),
          expiresAt: isoOffsetSeconds(ttl),
          now,
        }),
      );
      receipts.deliveries.push({ address_id: target.id, message_id: messageId });
    }
    await tx.insert(agentBusPublications).values({
      id: publicationId,
      topic,
      senderAddressId: sender.id,
      clientMessageId: clientId,
      payloadSha256: digest,
      contentBytes: Buffer.byteLength(content, 'utf8'),
      ttlSeconds: ttl,
      receipts,
      createdAt: now,
    });
    return {
      publication_id: publicationId,
      topic,
      created: true,
      recipient_count: receipts.deliveries.length,
      ...receipts,
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
    return this.notify(
      await this.asAgent(sessionId, token, (tx, sender) => this.publish(tx, sender, sessionId, input)),
    );
  }
  async publishAdmin(input: PublicationInput) {
    return this.notify(
      await this.core.db.transaction(async (tx) => {
        await this.core.requireEnabledLocked(tx);
        return this.publish(tx, await this.server(tx), null, input);
      }),
    );
  }
}

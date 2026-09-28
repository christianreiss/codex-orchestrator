import { and, asc, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import { agentBusAddresses, agentBusConferenceMembers, agentBusConferences, agentBusConversations, agentBusMessages, agentSessions, hosts } from '../../db/schema.js';
import { NotFoundError } from '../../http/errors.js';
import { isoOffsetSeconds } from '../../util/timestamp.js';
import { deriveAddressPresence } from '../agent-presence.js';
import type { AdminCore } from './admin.js';
import { normalizeUuid } from './normalize.js';
import { messageMetadata, publicAddress, publicConferenceMember } from './views.js';

export interface ConferencePageOptions { before?: number; after?: number; limit?: number }

/** Read-only projections: inspecting a room must never sweep or consume its work. */
export class AgentMessagingConferenceAdmin {
  constructor(private readonly core: Pick<AdminCore, 'db' | 'decodeContent'>) {}

  private async rooms(status?: string, id?: string, limit = 100) {
    const predicates = [];
    if (status) predicates.push(status === 'open' ? inArray(agentBusConferences.status, ['open', 'adjourning']) : eq(agentBusConferences.status, status));
    if (id) predicates.push(eq(agentBusConferences.id, normalizeUuid(id, 'conference_id')));
    return this.core.db.select().from(agentBusConferences).where(and(...predicates))
      .orderBy(desc(agentBusConferences.createdAt), desc(agentBusConferences.id)).limit(limit);
  }

  private async members(ids: string[]) {
    if (!ids.length) return [];
    return this.core.db.select({ member: agentBusConferenceMembers, address: agentBusAddresses, session: agentSessions,
      fqdn: hosts.fqdn, conversation: agentBusConversations, dispatch: agentBusMessages })
      .from(agentBusConferenceMembers)
      .leftJoin(agentBusAddresses, eq(agentBusAddresses.id, agentBusConferenceMembers.addressId))
      .leftJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
      .leftJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
      .leftJoin(agentBusConversations, eq(agentBusConversations.id, agentBusConferenceMembers.conversationId))
      .leftJoin(agentBusMessages, eq(agentBusMessages.id, agentBusConferenceMembers.dispatchMessageId))
      .where(inArray(agentBusConferenceMembers.conferenceId, ids));
  }

  async list(options: { status?: string; limit?: number } = {}) {
    const rooms = await this.rooms(options.status, undefined, options.limit ?? 100);
    const members = await this.members(rooms.map((room) => room.id));
    return { conferences: rooms.map((room) => {
      const roster = members.filter((row) => row.member.conferenceId === room.id);
      const chair = roster.find((row) => row.member.role === 'owner');
      return { id: room.id, topic: room.topic, purpose: room.purpose, status: room.status,
        chair: chair?.address ? publicAddress(chair.address, chair.fqdn ?? undefined) : null,
        member_count: roster.filter((row) => row.member.state !== 'left').length,
        total_members: roster.length, max_members: room.maxMembers, deadline_at: room.deadlineAt,
        created_at: room.createdAt, adjourned_at: room.adjournedAt, adjourn_reason: room.adjournReason,
        last_activity_at: roster.reduce((latest, row) => [latest, row.member.updatedAt, row.conversation?.lastActivityAt ?? ''].sort().at(-1)!, room.updatedAt),
      };
    }) };
  }

  async detail(id: string) {
    const room = (await this.rooms(undefined, id, 1))[0];
    if (!room) throw new NotFoundError('Conference not found', 'agent_messaging_conference_not_found');
    const rows = await this.members([room.id]);
    return { conference: { id: room.id, topic: room.topic, purpose: room.purpose, status: room.status,
      deadline_at: room.deadlineAt, max_members: room.maxMembers, created_at: room.createdAt,
      adjourned_at: room.adjournedAt, adjourn_reason: room.adjournReason },
      members: rows.map(({ member, address, session, fqdn, conversation, dispatch }) => ({
        ...(address ? publicConferenceMember(member, address, fqdn) : {}),
        id: member.id, address_id: member.addressId, role: member.role, state: member.state,
        peer: address ? publicAddress(address, fqdn ?? undefined, deriveAddressPresence(address, session, isoOffsetSeconds(-45))) : null,
        conversation_id: member.conversationId, conversation_status: conversation?.status ?? null,
        dispatch_message_id: member.dispatchMessageId, dispatch_status: dispatch?.status ?? null,
        dispatch_error: dispatch?.lastErrorCode ?? null, left_at: member.leftAt,
      })) };
  }

  async messages(id: string, options: ConferencePageOptions = {}, revealIds?: string[]) {
    if (!(await this.rooms(undefined, id, 1)).length) throw new NotFoundError('Conference not found', 'agent_messaging_conference_not_found');
    const predicates = [eq(agentBusConferenceMembers.conferenceId, id)];
    if (options.before !== undefined) predicates.push(lt(agentBusMessages.dispatchOrder, options.before));
    if (options.after !== undefined) predicates.push(gt(agentBusMessages.dispatchOrder, options.after));
    if (revealIds) predicates.push(inArray(agentBusMessages.id, revealIds));
    const limit = options.limit ?? 100;
    const rows = await this.core.db.select({ message: agentBusMessages }).from(agentBusMessages)
      .innerJoin(agentBusConferenceMembers, eq(agentBusConferenceMembers.conversationId, agentBusMessages.conversationId))
      .where(and(...predicates)).orderBy(options.after === undefined ? desc(agentBusMessages.dispatchOrder) : asc(agentBusMessages.dispatchOrder))
      .limit(limit + 1);
    const selected = rows.slice(0, limit).map((row) => row.message).sort((a, b) => a.dispatchOrder - b.dispatchOrder);
    // The reveal allowlist is scoped by the conference join, including ordinary replies.
    if (revealIds && selected.length !== new Set(revealIds).size) throw new NotFoundError('Conference message not found', 'agent_messaging_message_not_found');
    const ids = [...new Set(selected.flatMap((row) => [row.senderAddressId, row.targetAddressId]))];
    const addresses = ids.length ? await this.core.db.select().from(agentBusAddresses).where(inArray(agentBusAddresses.id, ids)) : [];
    const peers = new Map(addresses.map((row) => [row.id, row]));
    return { messages: selected.map((row) => ({ ...messageMetadata(row, peers.get(row.senderAddressId), peers.get(row.targetAddressId)),
      id: row.id, dispatch_order: row.dispatchOrder, ...(revealIds ? { content: this.core.decodeContent(row) } : {}) })),
      oldest_cursor: selected[0]?.dispatchOrder ?? null, newest_cursor: selected.at(-1)?.dispatchOrder ?? null,
      has_more: rows.length > limit };
  }
}

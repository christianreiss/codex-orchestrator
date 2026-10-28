/**
 * The `CONF/1` wire envelope and the room-bounded message expiry.
 *
 * Part of the `agent-messaging` module; the public interface is the
 * `AgentMessagingService` facade in `../agent-messaging.ts`.
 */

import { createHash } from 'node:crypto';

import { sql, type SQLWrapper } from 'drizzle-orm';
import { agentBusMessages, type AgentBusConference, type AgentBusMessage } from '../../db/schema.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import { ConflictError } from '../../http/errors.js';
import { isoOffsetSeconds } from '../../util/timestamp.js';
import {
  AGENT_MESSAGING_MAX_TTL_SECONDS,
} from './constants.js';

/**
 * The wire envelope: `CONF/1 <VERB> k=v ...` on the first line, free text below.
 *
 * Composed server-side so the conference id always travels with the message. A
 * relay-woken member is a fresh process whose entire context is the prompt it
 * was booted with -- if the id were left to the sender to remember to include,
 * a headless participant would have no way to call `agent_conf_join` and answer.
 *
 * Values are sanitised to a single line: the header is exactly the first line,
 * so a newline smuggled into a topic would push the body up into the header and
 * change how a peer parses the whole message.
 */
export function conferenceEnvelope(
  verb: string,
  headers: Record<string, string | number | null | undefined>,
  body: string,
): string {
  const parts = [`CONF/1 ${verb}`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === null || value === undefined || value === '') continue;
    parts.push(`${key}=${String(value).replace(/[\r\n]+/g, ' ').trim()}`);
  }
  const header = parts.join(' ');
  const text = body.trim();
  return text ? `${header}\n${text}` : header;
}

/**
 * The rendezvous key of an open-or-join room: who may converge on it and on what.
 *
 * `identity` is the caller's `repositoryIdentity` -- the same repository identity
 * that decides which project scope room a session belongs to -- so only agents
 * working in the same repository (or, with no repository remote, on the same host
 * and checkout or directory) can find each other. The topic must already be
 * normalized with `normalizeConferenceTopicKey`. Hashed to a fixed width so the
 * unique index never depends on topic length, and so the key reveals nothing.
 */
export function conferenceRendezvousKey(identity: string, topicKey: string): string {
  return createHash('sha256').update(`conference-rendezvous/v1\0${identity}\0${topicKey}`).digest('hex');
}

/** A deadlock or duplicate on the rendezvous index means another opener won the race. */
export function isRendezvousRaceError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 4; depth += 1) {
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(String(candidate.code))) return true;
    if (candidate.errno === 1062 || candidate.errno === 1213 || candidate.errno === 1205) return true;
    current = candidate.cause;
  }
  return false;
}

export function conferenceInviteBody(conference: AgentBusConference, note: string): string {
  const lines = [
    `You are invited to a conference chaired by another agent.`,
    conference.topic ? `Topic: ${conference.topic}` : null,
    conference.purpose ? `Purpose: ${conference.purpose}` : null,
    '',
    `To accept, call agent_conf_join with conference_id="${conference.id}" and a short purpose`,
    `describing what you bring. The chair runs the room: it dispatches tasks and adjourns.`,
    `Reply to this message to decline.`,
    note ? `\n${note}` : null,
  ];
  return lines.filter((line) => line !== null).join('\n');
}

/**
 * A conference message must not outlive the room it belongs to, and must still
 * satisfy the bus's own TTL bounds.
 */
export function conferenceMessageExpiry(conference: AgentBusConference, now: string): string {
  const deadline = Date.parse(conference.deadlineAt), start = Date.parse(now);
  if (!Number.isFinite(deadline) || !Number.isFinite(start))
    throw new ConflictError('Invalid conference deadline', 'agent_messaging_conference_expired');
  const maximum = isoOffsetSeconds(AGENT_MESSAGING_MAX_TTL_SECONDS, new Date(start));
  return deadline <= Date.parse(maximum) ? conference.deadlineAt : maximum;
}

/** Admission only: accepted work may still finish and retain its result. */
export function ownedConferenceAdmissionOpen(snapshot: OwnerStateSnapshot, message: Pick<AgentBusMessage, 'id' | 'conversationId' | 'replyToMessageId' | 'kind' | 'workKind' | 'senderAddressId' | 'targetAddressId'>, now: string): boolean {
  const parent = message.replyToMessageId ? snapshot.messages.get(message.replyToMessageId) : undefined;
  if (message.kind === 'reply' && !message.workKind && parent?.workKind && parent.acceptedAt &&
      parent.conversationId === message.conversationId && parent.senderAddressId === message.targetAddressId &&
      parent.targetAddressId === message.senderAddressId) return true;
  const roomOpen = snapshot.table('agentRoomDeliveries').by('messageId', message.id).every(delivery => {
    const event = snapshot.table('agentRoomEvents').get(delivery.eventId);
    const conference = event && snapshot.table('agentBusConferences').get(event.roomId);
    return !conference || Date.parse(conference.deadlineAt) > Date.parse(now);
  });
  return roomOpen && snapshot.table('agentBusConferenceMembers').by('conversationId', message.conversationId).every(member => {
    const conference = snapshot.table('agentBusConferences').get(member.conferenceId);
    return !conference || Date.parse(conference.deadlineAt) > Date.parse(now);
  });
}

/** Indexed lookup in the existing claim/ACK statement, without another SQL round trip. */
export function conferenceAdmissionOpenSql(now: string, alias?: 'earlier' | 'in_flight') {
  const column = (name: string, original: SQLWrapper) => alias
    ? sql`${sql.identifier(alias)}.${sql.identifier(name)}` : sql`${original}`;
  const message = {
    id: column('id', agentBusMessages.id), kind: column('kind', agentBusMessages.kind),
    workKind: column('work_kind', agentBusMessages.workKind),
    replyToMessageId: column('reply_to_message_id', agentBusMessages.replyToMessageId),
    conversationId: column('conversation_id', agentBusMessages.conversationId),
    senderAddressId: column('sender_address_id', agentBusMessages.senderAddressId),
    targetAddressId: column('target_address_id', agentBusMessages.targetAddressId),
  };
  return sql<number>`((${message.kind} = 'reply' AND ${message.workKind} IS NULL AND EXISTS (
    SELECT 1 FROM agent_bus_messages AS accepted_parent
    WHERE accepted_parent.id = ${message.replyToMessageId}
      AND accepted_parent.accepted_at IS NOT NULL AND accepted_parent.work_kind IS NOT NULL
      AND accepted_parent.conversation_id = ${message.conversationId}
      AND accepted_parent.sender_address_id = ${message.targetAddressId}
      AND accepted_parent.target_address_id = ${message.senderAddressId}
  )) OR (NOT EXISTS (
    SELECT 1 FROM agent_bus_conference_members AS conference_member
    INNER JOIN agent_bus_conferences AS conference_room ON conference_room.id = conference_member.conference_id
    WHERE conference_member.conversation_id = ${message.conversationId}
      AND conference_room.deadline_at <= ${now}
  ) AND NOT EXISTS (
    SELECT 1 FROM agent_room_deliveries AS conference_delivery
    INNER JOIN agent_room_events AS conference_event ON conference_event.id = conference_delivery.event_id
    INNER JOIN agent_bus_conferences AS delivery_room ON delivery_room.id = BINARY conference_event.room_id
    WHERE conference_delivery.message_id = ${message.id} AND delivery_room.deadline_at <= ${now}
  )))`;
}

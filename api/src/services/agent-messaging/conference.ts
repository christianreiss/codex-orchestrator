/**
 * Conferences: an owner, a roster, and the authority to dispatch and adjourn.
 *
 * Split out of `../agent-messaging.ts`; `AgentMessagingService` owns one
 * coordinator and delegates its seven conference calls to it. The service
 * remains the interface every caller uses.
 */

import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  count,
  eq,
  gt,
  isNotNull,
  lte,
  ne,
} from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import {
  agentBusAddresses,
  agentBusConferenceMembers,
  agentBusConferences,
  agentBusConversations,
  agentBusMessages,
  hosts,
  type AgentBusAddress,
  type AgentBusConference,
  type AgentBusConferenceMember,
  type AgentBusConversation,
  type AgentBusMessage,
  type AgentSession,
  type Host,
} from '../../db/schema.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import {
  AGENT_MESSAGING_MAX_BODY_BYTES,
  AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP,
} from './constants.js';
import {
  conferenceEnvelope,
  conferenceInviteBody,
  conferenceMessageExpiry,
} from './conference-protocol.js';
import { errorCodeOf, errorMessageOf } from './internals.js';
import {
  normalizeCallPin,
  normalizeConferenceMaxMembers,
  normalizeConferenceTtl,
  normalizeDispatchEta,
  normalizeMessageBody,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeUuid,
} from './normalize.js';
import type { AgentMessagingDb } from './types.js';
import { newQueuedMessage, publicAddress, publicConferenceMember } from './views.js';

/**
 * What the coordinator needs from the rest of the bus.
 *
 * Conferences ride on ordinary two-party conversations, so every primitive here
 * is one the 1:1 path already owns: address resolution, bridge authentication,
 * the shared four-digit PIN space, and conversation cancellation. Naming them
 * as an interface rather than reaching into the service keeps the direction of
 * the dependency one-way and makes the room's own rules the only thing this
 * file is about.
 */
export interface ConferenceCore {
  readonly db: Database;
  readonly keyring: Keyring;
  requireEnabledLocked(db: AgentMessagingDb): Promise<void>;
  requireAddressLocked(db: AgentMessagingDb, id: string): Promise<AgentBusAddress>;
  resolveAddressLocked(db: AgentMessagingDb, raw: string, forUpdate: boolean): Promise<AgentBusAddress>;
  authenticateBridge(
    sessionId: string,
    rawToken: string,
    allowEnded?: boolean,
  ): Promise<{ session: AgentSession; host: Host }>;
  assertSessionAddressLocked(db: AgentMessagingDb, sessionId: string, address: AgentBusAddress): Promise<void>;
  assertAddressEligibleLocked(db: AgentMessagingDb, address: AgentBusAddress): Promise<void>;
  sweepCallPinsLocked(db: AgentMessagingDb, now: string): Promise<void>;
  livePinsLocked(db: AgentMessagingDb): Promise<Set<string>>;
  pickFreePin(taken: Set<string>): string;
  requireConversationLocked(db: AgentMessagingDb, id: string): Promise<AgentBusConversation>;
  cancelConversationInternal(
    conversationId: string,
    canceledBy: string,
    reason: string,
    participantAddressId?: string,
    participantSessionId?: string,
  ): Promise<Record<string, unknown>>;
  assertConversationParticipants(conversation: AgentBusConversation, first: string, second: string): void;
}

export class ConferenceCoordinator {
  constructor(private readonly core: ConferenceCore) {}

  // =====================================================================
  // Conferences
  //
  // A conference is an owner, a roster, and the authority to dispatch and
  // adjourn. Its transport is a star: every member holds one ordinary
  // two-party conversation with the owner, and the owner relays. Nothing here
  // introduces an N-party conversation, because the delivery leases, the
  // per-conversation sequence and the one-in-flight-per-address rule in
  // `claimDelivery` are all written against exactly two participants.
  //
  // The 1:1 call's token invariant -- "at any instant exactly one side holds
  // the token" -- does not survive N parties, so it is replaced rather than
  // stretched. Every message creates exactly one obligation, and the chair's
  // reply to a participant is always turn-terminal: a participant that
  // receives one goes back to listening or exits, it does not reply again.
  // Only the chair opens a round. That asymmetry is what makes a five-way
  // room terminate; the skill states it, and these methods are shaped so an
  // agent following it cannot accidentally start a second round.
  // =====================================================================

  private async requireConferenceLocked(db: AgentMessagingDb, id: string): Promise<AgentBusConference> {
    const rows = await db.select().from(agentBusConferences).where(eq(agentBusConferences.id, id)).limit(1).for('update');
    const conference = rows[0];
    if (!conference) throw new NotFoundError('Conference not found', 'agent_messaging_conference_not_found');
    return conference;
  }

  private async requireMemberLocked(
    db: AgentMessagingDb,
    conferenceId: string,
    addressId: string,
  ): Promise<AgentBusConferenceMember> {
    const rows = await db
      .select()
      .from(agentBusConferenceMembers)
      .where(and(eq(agentBusConferenceMembers.conferenceId, conferenceId), eq(agentBusConferenceMembers.addressId, addressId)))
      .limit(1)
      .for('update');
    const member = rows[0];
    if (!member || member.state === 'left') {
      throw new ForbiddenError('Not a member of this conference', 'agent_messaging_conference_not_member');
    }
    return member;
  }

  /** Dispatch and adjourn are the chair's alone; everything else any member may do. */
  private async requireChairLocked(
    db: AgentMessagingDb,
    conferenceId: string,
    addressId: string,
  ): Promise<AgentBusConferenceMember> {
    const member = await this.requireMemberLocked(db, conferenceId, addressId);
    if (member.role !== 'owner') {
      throw new ForbiddenError('Only the conference owner can do that', 'agent_messaging_conference_not_owner');
    }
    return member;
  }

  private assertConferenceOpen(conference: AgentBusConference, now: string): void {
    if (conference.status !== 'open') {
      throw new ConflictError('Conference is adjourned', 'agent_messaging_conference_adjourned');
    }
    if (conference.deadlineAt <= now) {
      throw new ConflictError('Conference deadline has passed', 'agent_messaging_conference_expired');
    }
  }

  /**
   * Which half of the delivery split a member sits on.
   *
   * `claimDelivery` already arbitrates this per message: a target with a live
   * wrapper attached is skipped by the relay and must claim for itself, while an
   * idle one is booted headless. The roster only records which side a member is
   * currently on, because the chair has to phrase a dispatch differently for a
   * listener than for a one-shot run. It is recomputed on every send rather than
   * stored at join, since a member that quits its terminal changes side.
   */
  private conferenceMode(address: AgentBusAddress): string {
    return address.currentSessionId ? 'attached' : 'headless';
  }

  private async rosterRowsLocked(db: AgentMessagingDb, conferenceId: string) {
    return await db
      .select({ member: agentBusConferenceMembers, address: agentBusAddresses, fqdn: hosts.fqdn })
      .from(agentBusConferenceMembers)
      .innerJoin(agentBusAddresses, eq(agentBusAddresses.id, agentBusConferenceMembers.addressId))
      .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
      .where(and(eq(agentBusConferenceMembers.conferenceId, conferenceId), ne(agentBusConferenceMembers.state, 'left')))
      .orderBy(asc(agentBusConferenceMembers.joinedAt));
  }

  /**
   * Queue one message along a member's spoke.
   *
   * The header line is composed here rather than left to the caller because a
   * relay-woken member has no prior context at all: its whole existence is the
   * prompt it is booted with, so the conference id has to travel inside the
   * message or it can never call `agent_conf_join` to answer. Composing it
   * server-side also means a peer that has never read the skill still receives a
   * parseable envelope.
   */
  private async queueConferenceMessageLocked(
    tx: AgentMessagingDb,
    input: {
      conference: AgentBusConference;
      member: AgentBusConferenceMember;
      sender: AgentBusAddress;
      target: AgentBusAddress;
      senderSessionId: string | null;
      verb: string;
      headers: Record<string, string | number | null | undefined>;
      body: string;
      now: string;
    },
  ): Promise<AgentBusMessage> {
    const { conference, member, sender, target, now } = input;
    if (member.messageCount >= AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP) {
      throw new ConflictError(
        `Conference budget spent for this member (${AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP} messages)`,
        'agent_messaging_conference_budget_spent',
      );
    }
    let conversationId = member.conversationId;
    if (!conversationId) {
      conversationId = randomUUID();
      await tx.insert(agentBusConversations).values({
        id: conversationId,
        addressAId: conference.ownerAddressId,
        addressBId: member.addressId,
        createdByAddressId: sender.id,
        nextSequence: 1,
        status: 'open',
        lastActivityAt: now,
        canceledBy: null,
        cancelReason: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(agentBusConferenceMembers)
        .set({ conversationId, updatedAt: now })
        .where(eq(agentBusConferenceMembers.id, member.id));
    }
    const conversation = await this.core.requireConversationLocked(tx, conversationId);
    if (conversation.status !== 'open') {
      throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
    }
    this.core.assertConversationParticipants(conversation, sender.id, target.id);
    const content = conferenceEnvelope(input.verb, { conference: conference.id, ...input.headers }, input.body);
    const sequence = Number(conversation.nextSequence);
    const messageId = randomUUID();
    await tx.insert(agentBusMessages).values(
      newQueuedMessage({
        id: messageId,
        conversationId,
        sequence,
        sender,
        senderSessionId: input.senderSessionId,
        target,
        kind: 'message',
        content,
        contentEnc: encrypt(content, this.core.keyring),
        // Server-generated: a conference send is a fan-out, so there is no single
        // client key that could identify it. Partial delivery is reported per
        // member instead, and re-sending to a member that already received one is
        // a second message by design rather than a swallowed duplicate.
        clientMessageId: randomUUID(),
        // A message must not outlive the room it belongs to.
        expiresAt: conferenceMessageExpiry(conference, now),
        now,
      }),
    );
    const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1);
    const persisted = persistedRows[0];
    if (!persisted) throw new Error('Inserted conference message could not be read back');
    await tx
      .update(agentBusConversations)
      .set({ nextSequence: sequence + 1, lastActivityAt: now, updatedAt: now })
      .where(eq(agentBusConversations.id, conversationId));
    const participant = sender.id === conference.ownerAddressId ? target : sender;
    const spent = member.messageCount + 1;
    await tx
      .update(agentBusConferenceMembers)
      .set({ messageCount: spent, mode: this.conferenceMode(participant), updatedAt: now })
      .where(eq(agentBusConferenceMembers.id, member.id));
    // The send path closes on the same boundary as the reply path. Incrementing
    // here without checking let a send land exactly on the cap and leave the
    // spoke open for one more reply, so a room advertised as twelve messages
    // stopped at thirteen -- observed on a live run.
    await this.closeSpokeIfSpentLocked(tx, member.id, conversationId, spent, now);
    return persisted;
  }

  /**
   * A dispatched member reports back by replying to the task it was given.
   *
   * Called from both reply paths, because the two member kinds report through
   * different ones: an attached member replies through `replyMessage`, while a
   * headless member never calls a tool at all -- the relay correlates its final
   * output and posts it through `replyFromRelayDelivery`. Hooking only the tool
   * path would leave every headless member stuck in `dispatched` forever.
   */
  async settleConferenceDispatchLocked(tx: AgentMessagingDb, parentMessageId: string, now: string): Promise<void> {
    const rows = await tx
      .select()
      .from(agentBusConferenceMembers)
      .where(and(eq(agentBusConferenceMembers.dispatchMessageId, parentMessageId), eq(agentBusConferenceMembers.state, 'dispatched')))
      .limit(1)
      .for('update');
    const member = rows[0];
    if (!member) return;
    await tx
      .update(agentBusConferenceMembers)
      .set({ state: 'seated', dispatchMessageId: null, dispatchDeadlineAt: null, lastReportAt: now, updatedAt: now })
      .where(eq(agentBusConferenceMembers.id, member.id));
  }

  /**
   * Charge a reply against the room's budget, and close the spoke when it runs out.
   *
   * The budget used to be charged only by `queueConferenceMessageLocked`, i.e. the
   * `agent_conf_*` tools. But once a room is running, the traffic is ordinary
   * `agent_reply` -- that is how a participant answers anything -- and replies
   * never reached the counter. Measured on a live two-host run: the member row
   * read 2 while 21 messages had flown, and nothing server-side was going to end
   * it before the wall-clock deadline. On the headless path every one of those
   * exchanges is a fresh engine boot, so "bounded only by an hour" is not a bound
   * worth having. This is the same runaway the `call` skill's own rationale
   * warns about, reappearing through the one path that was not counted.
   *
   * Spending the budget closes the member's conversation rather than refusing the
   * reply. Refusing would strand the peer holding an unanswerable message, and on
   * the relay path a throw here becomes an `ambiguous` delivery -- the exact
   * silent failure mode this bus has been fixing all week. Closing lets the last
   * word land and makes the *next* exchange fail as `agent_messaging_conversation_canceled`,
   * which both skills already define as "the room closed under you: report and stop".
   */
  async chargeConferenceBudgetLocked(
    db: AgentMessagingDb,
    conversationId: string,
    now: string,
  ): Promise<void> {
    const rows = await db
      .select()
      .from(agentBusConferenceMembers)
      .where(and(eq(agentBusConferenceMembers.conversationId, conversationId), ne(agentBusConferenceMembers.state, 'left')))
      .limit(1)
      .for('update');
    const member = rows[0];
    if (!member) return; // Not a conference spoke; an ordinary conversation is unbudgeted.

    const spent = member.messageCount + 1;
    await db
      .update(agentBusConferenceMembers)
      .set({ messageCount: spent, updatedAt: now })
      .where(eq(agentBusConferenceMembers.id, member.id));
    await this.closeSpokeIfSpentLocked(db, member.id, conversationId, spent, now);
  }

  /**
   * Retire a member's spoke once its budget is gone.
   *
   * Shared by both the send and reply paths so the room stops on the number it
   * advertises: whichever path spends the last message is the one that closes.
   */
  private async closeSpokeIfSpentLocked(
    db: AgentMessagingDb,
    memberId: string,
    conversationId: string,
    spent: number,
    now: string,
  ): Promise<void> {
    if (spent < AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP) return;
    await db
      .update(agentBusConferenceMembers)
      .set({ state: 'left', leftAt: now, dispatchMessageId: null, dispatchDeadlineAt: null, updatedAt: now })
      .where(eq(agentBusConferenceMembers.id, memberId));
    await db
      .update(agentBusConversations)
      .set({
        status: 'canceled',
        canceledBy: 'system:conference_budget_spent',
        cancelReason: `Conference budget spent (${AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP} messages)`,
        canceledAt: now,
        updatedAt: now,
      })
      .where(eq(agentBusConversations.id, conversationId));
  }

  /**
   * Open a conference and mint the room PIN.
   *
   * One open conference per owner. A second would give the chair two rooms to
   * keep straight and two budgets to spend, and every mechanism here -- the
   * roster, the floor, the adjourn authority -- assumes the chair is running one
   * meeting. Re-opening returns the existing room rather than minting a rival.
   */
  async open(
    sessionId: string,
    bridgeToken: string,
    input: { topic?: string | null; purpose?: string | null; ttlSeconds?: number | null; maxMembers?: number | null } = {},
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken);
    if (!authenticated.session.agentBusAddressId) {
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    }
    const topic = normalizeOptionalText(input.topic, 255);
    const purpose = normalizeOptionalText(input.purpose, 1024);
    const ttlSeconds = normalizeConferenceTtl(input.ttlSeconds);
    const maxMembers = normalizeConferenceMaxMembers(input.maxMembers);
    const result = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const now = nowIso();
      await this.core.sweepCallPinsLocked(tx, now);
      const self = await this.core.requireAddressLocked(tx, authenticated.session.agentBusAddressId!);
      await this.core.assertSessionAddressLocked(tx, authenticated.session.id, self);
      await this.core.assertAddressEligibleLocked(tx, self);
      const openRows = await tx
        .select()
        .from(agentBusConferences)
        .where(and(eq(agentBusConferences.ownerAddressId, self.id), eq(agentBusConferences.status, 'open'), gt(agentBusConferences.deadlineAt, now)))
        .limit(1)
        .for('update');
      const existing = openRows[0];
      if (existing) {
        const pin =
          existing.pin && existing.pinExpiresAt && existing.pinExpiresAt > now
            ? existing.pin
            : await this.mintConferencePinLocked(tx, existing.id, existing.deadlineAt, now);
        return { conference: { ...existing, pin }, self, reused: true };
      }
      const conference: typeof agentBusConferences.$inferInsert = {
        id: randomUUID(),
        ownerAddressId: self.id,
        topic,
        purpose,
        pin: null,
        pinExpiresAt: null,
        status: 'open',
        maxMembers,
        deadlineAt: isoOffsetSeconds(ttlSeconds),
        adjournReason: null,
        adjournedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentBusConferences).values(conference);
      await tx.insert(agentBusConferenceMembers).values({
        id: randomUUID(),
        conferenceId: conference.id,
        addressId: self.id,
        conversationId: null,
        role: 'owner',
        purpose,
        mode: this.conferenceMode(self),
        state: 'seated',
        dispatchMessageId: null,
        dispatchDeadlineAt: null,
        dispatchedAt: null,
        lastReportAt: null,
        messageCount: 0,
        joinedAt: now,
        leftAt: null,
        createdAt: now,
        updatedAt: now,
      });
      // The PIN dies with the room, so its window is the room's deadline.
      const pin = await this.mintConferencePinLocked(tx, conference.id, conference.deadlineAt, now);
      return { conference: { ...conference, pin } as AgentBusConference, self, reused: false };
    });
    const roster = await this.core.db.transaction(async (tx) => await this.rosterRowsLocked(tx, result.conference.id));
    return {
      enabled: true,
      conference_id: result.conference.id,
      pin: result.conference.pin,
      expires_at: result.conference.deadlineAt,
      deadline_at: result.conference.deadlineAt,
      topic: result.conference.topic,
      max_members: result.conference.maxMembers,
      reused: result.reused,
      self: publicAddress(result.self),
      roster: roster.map((row) => publicConferenceMember(row.member, row.address, row.fqdn)),
    };
  }

  /**
   * Invite addresses into the room.
   *
   * This is the path that makes a conference usable on a cluster: an idle host
   * is woken by its relay with the invite as its prompt, so no human carries
   * anything. A host with a wrapper already attached is skipped by the relay by
   * design and its invite simply waits in the queue until that session listens
   * -- which is exactly the case the PIN still exists to cover.
   *
   * Not atomic, and deliberately not pretending to be: each member is its own
   * conversation and its own delivery, so the result is per member and a partial
   * fan-out is reported rather than rolled back.
   */
  async invite(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; to: string[]; note?: string | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id');
    const note = normalizeOptionalText(input.note, AGENT_MESSAGING_MAX_BODY_BYTES) ?? '';
    if (!Array.isArray(input.to) || input.to.length === 0) {
      throw new ValidationError('to must be a non-empty list of addresses', { param: 'to' });
    }
    const targets = input.to.map((value) => normalizeRequiredText(value, 'to', 96));
    const results: Record<string, unknown>[] = [];
    for (const target of targets) {
      try {
        const queued = await this.core.db.transaction(async (tx) => {
          await this.core.requireEnabledLocked(tx);
          const now = nowIso();
          const conference = await this.requireConferenceLocked(tx, conferenceId);
          this.assertConferenceOpen(conference, now);
          await this.requireChairLocked(tx, conferenceId, selfId);
          const chair = await this.core.requireAddressLocked(tx, selfId);
          await this.core.assertSessionAddressLocked(tx, authenticated.session.id, chair);
          const invitee = await this.core.resolveAddressLocked(tx, target, true);
          if (invitee.id === chair.id) {
            throw new ValidationError('The chair is already in the conference', { param: 'to' });
          }
          await this.core.assertAddressEligibleLocked(tx, invitee);
          const seated = await tx
            .select({ value: count() })
            .from(agentBusConferenceMembers)
            .where(and(eq(agentBusConferenceMembers.conferenceId, conferenceId), ne(agentBusConferenceMembers.state, 'left')));
          if (Number(seated[0]?.value ?? 0) >= conference.maxMembers) {
            throw new ConflictError('Conference is full', 'agent_messaging_conference_full');
          }
          const priorRows = await tx
            .select()
            .from(agentBusConferenceMembers)
            .where(and(eq(agentBusConferenceMembers.conferenceId, conferenceId), eq(agentBusConferenceMembers.addressId, invitee.id)))
            .limit(1)
            .for('update');
          if (priorRows[0] && priorRows[0].state !== 'left') {
            throw new ConflictError('Address is already a member', 'agent_messaging_conference_already_member');
          }
          const member: typeof agentBusConferenceMembers.$inferInsert = {
            id: priorRows[0]?.id ?? randomUUID(),
            conferenceId,
            addressId: invitee.id,
            conversationId: priorRows[0]?.conversationId ?? null,
            role: 'participant',
            purpose: null,
            mode: this.conferenceMode(invitee),
            state: 'seated',
            dispatchMessageId: null,
            dispatchDeadlineAt: null,
            dispatchedAt: null,
            lastReportAt: null,
            messageCount: priorRows[0]?.messageCount ?? 0,
            joinedAt: now,
            leftAt: null,
            createdAt: priorRows[0]?.createdAt ?? now,
            updatedAt: now,
          };
          if (priorRows[0]) {
            await tx.update(agentBusConferenceMembers).set(member).where(eq(agentBusConferenceMembers.id, member.id!));
          } else {
            await tx.insert(agentBusConferenceMembers).values(member);
          }
          const stored = await this.requireMemberLocked(tx, conferenceId, invitee.id);
          const message = await this.queueConferenceMessageLocked(tx, {
            conference,
            member: stored,
            sender: chair,
            target: invitee,
            senderSessionId: authenticated.session.id,
            verb: 'INVITE',
            headers: {
              topic: conference.topic ?? undefined,
              deadline: conference.deadlineAt,
              members: `${Number(seated[0]?.value ?? 0) + 1}/${conference.maxMembers}`,
            },
            body: conferenceInviteBody(conference, note),
            now,
          });
          return { message, invitee, mode: stored.mode };
        });
        wsPublisher.publish('agent_messaging.message.changed', {
          message_id: queued.message.id,
          conversation_id: queued.message.conversationId,
          status: queued.message.status,
        });
        results.push({
          address: queued.invitee.address,
          alias: queued.invitee.displayAlias,
          mode: this.conferenceMode(queued.invitee),
          delivered: true,
          message_id: queued.message.id,
        });
      } catch (error) {
        results.push({ address: target, delivered: false, error: errorCodeOf(error), detail: errorMessageOf(error) });
      }
    }
    return { enabled: true, conference_id: conferenceId, results };
  }

  /**
   * Join a room, by PIN or by invitation.
   *
   * The PIN path is multi-use, which is the whole difference from `#call`: four
   * agents dial the same four digits, so unlike `consumeCallPinLocked` this must
   * never clear the PIN on success. It dies with the room's deadline or when the
   * room fills, not on first use.
   *
   * The `conference_id` path exists for a relay-woken invitee, which learns the
   * id from the invite it was booted with. It requires an existing member row,
   * so knowing a UUID is not by itself an entry ticket.
   */
  async join(
    sessionId: string,
    bridgeToken: string,
    input: { pin?: string | null; conferenceId?: string | null; purpose?: string | null; content?: string | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const hasPin = input.pin !== undefined && input.pin !== null && input.pin !== '';
    const hasId = input.conferenceId !== undefined && input.conferenceId !== null && input.conferenceId !== '';
    if (hasPin === hasId) {
      throw new ValidationError('Provide exactly one of pin or conference_id', { param: 'pin' });
    }
    const pin = hasPin ? normalizeCallPin(input.pin) : null;
    const conferenceId = hasId ? normalizeUuid(input.conferenceId, 'conference_id') : null;
    const purpose = normalizeOptionalText(input.purpose, 1024);
    const body = normalizeOptionalText(input.content, AGENT_MESSAGING_MAX_BODY_BYTES) ?? '';
    const result = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const now = nowIso();
      await this.core.sweepCallPinsLocked(tx, now);
      const self = await this.core.requireAddressLocked(tx, selfId);
      await this.core.assertSessionAddressLocked(tx, authenticated.session.id, self);
      const conference = pin
        ? await this.resolveConferencePinLocked(tx, pin, now)
        : await this.requireConferenceLocked(tx, conferenceId!);
      this.assertConferenceOpen(conference, now);
      if (conference.ownerAddressId === self.id) {
        throw new ValidationError('The chair is already in the conference', { param: 'pin' });
      }
      const chair = await this.core.requireAddressLocked(tx, conference.ownerAddressId);
      await this.core.assertAddressEligibleLocked(tx, chair);
      const priorRows = await tx
        .select()
        .from(agentBusConferenceMembers)
        .where(and(eq(agentBusConferenceMembers.conferenceId, conference.id), eq(agentBusConferenceMembers.addressId, self.id)))
        .limit(1)
        .for('update');
      const prior = priorRows[0];
      if (!prior && !pin) {
        // An id alone is not an invitation.
        throw new ForbiddenError('Not a member of this conference', 'agent_messaging_conference_not_member');
      }
      if (!prior) {
        const seated = await tx
          .select({ value: count() })
          .from(agentBusConferenceMembers)
          .where(and(eq(agentBusConferenceMembers.conferenceId, conference.id), ne(agentBusConferenceMembers.state, 'left')));
        if (Number(seated[0]?.value ?? 0) >= conference.maxMembers) {
          throw new ConflictError('Conference is full', 'agent_messaging_conference_full');
        }
        await tx.insert(agentBusConferenceMembers).values({
          id: randomUUID(),
          conferenceId: conference.id,
          addressId: self.id,
          conversationId: null,
          role: 'participant',
          purpose,
          mode: this.conferenceMode(self),
          state: 'seated',
          dispatchMessageId: null,
          dispatchDeadlineAt: null,
          dispatchedAt: null,
          lastReportAt: null,
          messageCount: 0,
          joinedAt: now,
          leftAt: null,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        await tx
          .update(agentBusConferenceMembers)
          .set({ state: 'seated', purpose: purpose ?? prior.purpose, mode: this.conferenceMode(self), leftAt: null, updatedAt: now })
          .where(eq(agentBusConferenceMembers.id, prior.id));
      }
      const member = await this.requireMemberLocked(tx, conference.id, self.id);
      const message = await this.queueConferenceMessageLocked(tx, {
        conference,
        member,
        sender: self,
        target: chair,
        senderSessionId: authenticated.session.id,
        verb: 'HELLO',
        headers: { purpose: purpose ?? undefined },
        body,
        now,
      });
      const roster = await this.rosterRowsLocked(tx, conference.id);
      return { conference, self, chair, message, roster };
    });
    wsPublisher.publish('agent_messaging.message.changed', {
      message_id: result.message.id,
      conversation_id: result.message.conversationId,
      status: result.message.status,
    });
    return {
      enabled: true,
      conference_id: result.conference.id,
      topic: result.conference.topic,
      deadline_at: result.conference.deadlineAt,
      chair: publicAddress(result.chair),
      self: publicAddress(result.self),
      roster: result.roster.map((row) => publicConferenceMember(row.member, row.address, row.fqdn)),
    };
  }

  /**
   * Resolve a room PIN without spending it.
   *
   * The contrast with `consumeCallPinLocked` is the point: a call PIN is
   * single-use because it names one rendezvous between two agents, while a room
   * PIN is how every member finds the same room. Clearing it on first join would
   * admit exactly one participant and turn a conference into a call.
   */
  private async resolveConferencePinLocked(db: AgentMessagingDb, pin: string, now: string): Promise<AgentBusConference> {
    const rows = await db
      .select()
      .from(agentBusConferences)
      .where(and(eq(agentBusConferences.pin, pin), gt(agentBusConferences.pinExpiresAt, now)))
      .limit(1)
      .for('update');
    const conference = rows[0];
    if (!conference) {
      throw new NotFoundError('Conference PIN not found or expired', 'agent_messaging_conference_pin_not_found');
    }
    return conference;
  }

  async roster(sessionId: string, bridgeToken: string, conferenceId: string): Promise<Record<string, unknown>> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const id = normalizeUuid(conferenceId, 'conference_id');
    return await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const conference = await this.requireConferenceLocked(tx, id);
      await this.requireMemberLocked(tx, id, selfId);
      const roster = await this.rosterRowsLocked(tx, id);
      return {
        enabled: true,
        conference_id: conference.id,
        topic: conference.topic,
        purpose: conference.purpose,
        status: conference.status,
        deadline_at: conference.deadlineAt,
        max_members: conference.maxMembers,
        members: roster.map((row) => publicConferenceMember(row.member, row.address, row.fqdn)),
      };
    });
  }

  /**
   * Say something. The chair broadcasts; a participant may only address the chair.
   *
   * A participant's `to` is ignored rather than rejected: the star has no edge
   * between participants, so there is nowhere for it to go, and failing the call
   * would punish an agent for a topology it cannot see.
   */
  async say(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; content: string; to?: string | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id');
    const body = normalizeMessageBody(input.content);
    const to = normalizeOptionalText(input.to, 96);
    const recipients = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const now = nowIso();
      const conference = await this.requireConferenceLocked(tx, conferenceId);
      this.assertConferenceOpen(conference, now);
      const me = await this.requireMemberLocked(tx, conferenceId, selfId);
      if (me.role !== 'owner') return { chairOnly: true, conference };
      const roster = await this.rosterRowsLocked(tx, conferenceId);
      const targets = roster
        .filter((row) => row.member.role !== 'owner')
        // A dispatched member is away on a task and holding a delivery; adding a
        // broadcast behind it would queue behind work it has not finished.
        .filter((row) => row.member.state === 'seated')
        .filter((row) => !to || row.address.address === to || row.address.displayAlias === to);
      return { chairOnly: false, conference, targets: targets.map((row) => row.address.id) };
    });
    const results: Record<string, unknown>[] = [];
    if (recipients.chairOnly) {
      const sent = await this.deliverConferenceMessage(authenticated, conferenceId, selfId, null, 'SAY', {}, body);
      results.push(sent);
    } else {
      for (const addressId of recipients.targets ?? []) {
        results.push(await this.deliverConferenceMessage(authenticated, conferenceId, selfId, addressId, 'SAY', {}, body));
      }
    }
    return { enabled: true, conference_id: conferenceId, results };
  }

  /**
   * Hand a task to one participant and take it off the floor.
   *
   * The member goes to `dispatched`, which excludes it from broadcast until its
   * report lands. `dispatch_deadline_at` is what the maintenance sweep uses to
   * notice a member whose run died: a headless task that never returns burns its
   * delivery attempts silently, and without the deadline the chair would wait
   * forever on a report that is not coming.
   */
  async dispatch(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; to: string; task: string; etaSeconds?: number | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id');
    const to = normalizeRequiredText(input.to, 'to', 96);
    const task = normalizeMessageBody(input.task);
    const etaSeconds = normalizeDispatchEta(input.etaSeconds);
    const result = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const now = nowIso();
      const conference = await this.requireConferenceLocked(tx, conferenceId);
      this.assertConferenceOpen(conference, now);
      await this.requireChairLocked(tx, conferenceId, selfId);
      const chair = await this.core.requireAddressLocked(tx, selfId);
      await this.core.assertSessionAddressLocked(tx, authenticated.session.id, chair);
      const target = await this.core.resolveAddressLocked(tx, to, true);
      await this.core.assertAddressEligibleLocked(tx, target);
      const member = await this.requireMemberLocked(tx, conferenceId, target.id);
      if (member.role === 'owner') {
        throw new ValidationError('The chair cannot dispatch itself', { param: 'to' });
      }
      if (member.state === 'dispatched') {
        throw new ConflictError('Member is already on a task', 'agent_messaging_conference_member_busy');
      }
      const message = await this.queueConferenceMessageLocked(tx, {
        conference,
        member,
        sender: chair,
        target,
        senderSessionId: authenticated.session.id,
        verb: 'TASK',
        headers: { eta: etaSeconds, deadline: conference.deadlineAt },
        body: task,
        now,
      });
      await tx
        .update(agentBusConferenceMembers)
        .set({
          state: 'dispatched',
          dispatchMessageId: message.id,
          dispatchDeadlineAt: isoOffsetSeconds(etaSeconds),
          dispatchedAt: now,
          updatedAt: now,
        })
        .where(eq(agentBusConferenceMembers.id, member.id));
      return { message, target };
    });
    wsPublisher.publish('agent_messaging.message.changed', {
      message_id: result.message.id,
      conversation_id: result.message.conversationId,
      status: result.message.status,
    });
    return {
      enabled: true,
      conference_id: conferenceId,
      dispatched_to: publicAddress(result.target),
      message_id: result.message.id,
      eta_seconds: etaSeconds,
    };
  }

  /**
   * Close the room.
   *
   * Graceful by default. Cancelling a conversation revokes any lease on it, and
   * a headless member mid-run is having its lease renewed on a ticker -- so a
   * blanket cancel kills a running engine process mid-task. That is sometimes
   * what the chair wants and never what it should get by accident, so the
   * default leaves dispatched members to finish and the room lands in
   * `adjourning` until their reports arrive or the sweep expires them. `force`
   * is the decisive form, and it reports how much work it interrupted.
   */
  async adjourn(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; reason?: string | null; force?: boolean },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id');
    const reason = normalizeOptionalText(input.reason, 255) ?? 'Adjourned by the chair';
    const force = input.force === true;
    const plan = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const now = nowIso();
      const conference = await this.requireConferenceLocked(tx, conferenceId);
      if (conference.status === 'adjourned') {
        throw new ConflictError('Conference is already adjourned', 'agent_messaging_conference_adjourned');
      }
      await this.requireChairLocked(tx, conferenceId, selfId);
      const roster = await this.rosterRowsLocked(tx, conferenceId);
      const participants = roster.filter((row) => row.member.role !== 'owner');
      const working = participants.filter((row) => row.member.state === 'dispatched');
      const releasable = force ? participants : participants.filter((row) => row.member.state !== 'dispatched');
      const settled = force || working.length === 0;
      await tx
        .update(agentBusConferences)
        .set({
          status: settled ? 'adjourned' : 'adjourning',
          adjournReason: reason,
          adjournedAt: settled ? now : null,
          pin: null,
          pinExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(agentBusConferences.id, conferenceId));
      for (const row of releasable) {
        await tx
          .update(agentBusConferenceMembers)
          .set({ state: 'left', leftAt: now, dispatchMessageId: null, dispatchDeadlineAt: null, updatedAt: now })
          .where(eq(agentBusConferenceMembers.id, row.member.id));
      }
      if (settled) {
        await tx
          .update(agentBusConferenceMembers)
          .set({ state: 'left', leftAt: now, updatedAt: now })
          .where(and(eq(agentBusConferenceMembers.conferenceId, conferenceId), ne(agentBusConferenceMembers.state, 'left')));
      }
      return {
        settled,
        interrupted: force ? working.length : 0,
        waitingOn: settled ? 0 : working.length,
        conversations: releasable.map((row) => row.member.conversationId).filter((id): id is string => Boolean(id)),
      };
    });
    for (const conversationId of plan.conversations) {
      try {
        await this.core.cancelConversationInternal(conversationId, `agent:${selfId}`, reason, selfId, authenticated.session.id);
      } catch {
        // A conversation already canceled or never opened is not a failure to
        // adjourn: the room is closing either way.
      }
    }
    wsPublisher.publish('agent_messaging.conference.changed', {
      conference_id: conferenceId,
      status: plan.settled ? 'adjourned' : 'adjourning',
    });
    return {
      enabled: true,
      conference_id: conferenceId,
      status: plan.settled ? 'adjourned' : 'adjourning',
      released: plan.conversations.length,
      interrupted_tasks: plan.interrupted,
      waiting_on_tasks: plan.waitingOn,
    };
  }

  /** One spoke of a fan-out, isolated so a single failure is reported rather than fatal. */
  private async deliverConferenceMessage(
    authenticated: { session: AgentSession; host: Host },
    conferenceId: string,
    selfId: string,
    targetAddressId: string | null,
    verb: string,
    headers: Record<string, string | number | null | undefined>,
    body: string,
  ): Promise<Record<string, unknown>> {
    try {
      const queued = await this.core.db.transaction(async (tx) => {
        await this.core.requireEnabledLocked(tx);
        const now = nowIso();
        const conference = await this.requireConferenceLocked(tx, conferenceId);
        this.assertConferenceOpen(conference, now);
        const self = await this.core.requireAddressLocked(tx, selfId);
        await this.core.assertSessionAddressLocked(tx, authenticated.session.id, self);
        const isChair = conference.ownerAddressId === self.id;
        const otherId = isChair ? targetAddressId! : conference.ownerAddressId;
        const other = await this.core.requireAddressLocked(tx, otherId);
        await this.core.assertAddressEligibleLocked(tx, other);
        const member = await this.requireMemberLocked(tx, conferenceId, isChair ? other.id : self.id);
        const message = await this.queueConferenceMessageLocked(tx, {
          conference,
          member,
          sender: self,
          target: other,
          senderSessionId: authenticated.session.id,
          verb,
          headers,
          body,
          now,
        });
        return { message, other };
      });
      wsPublisher.publish('agent_messaging.message.changed', {
        message_id: queued.message.id,
        conversation_id: queued.message.conversationId,
        status: queued.message.status,
      });
      return {
        address: queued.other.address,
        alias: queued.other.displayAlias,
        delivered: true,
        message_id: queued.message.id,
      };
    } catch (error) {
      return { address: targetAddressId, delivered: false, error: errorCodeOf(error), detail: errorMessageOf(error) };
    }
  }

  /** Pick a free PIN and bind it to this conference. */
  private async mintConferencePinLocked(
    db: AgentMessagingDb,
    conferenceId: string,
    expiresAt: string,
    now: string,
  ): Promise<string> {
    const pin = this.core.pickFreePin(await this.core.livePinsLocked(db));
    await db
      .update(agentBusConferences)
      .set({ pin, pinExpiresAt: expiresAt, updatedAt: now })
      .where(eq(agentBusConferences.id, conferenceId));
    return pin;
  }

  /**
   * Close rooms nobody is going to close, and un-strand members nobody is going
   * to answer for.
   *
   * Both halves exist because the failure they cover is silent. A chair that
   * simply walks away leaves an `open` conference holding a PIN that still
   * admits joiners; and a headless member whose engine died mid-task burns its
   * delivery attempts until the message goes `dead` without ever touching the
   * member row, so the chair waits forever on a report that is not coming. Any
   * budget that is only enforced by participants behaving well is not a budget.
   */
  async sweepConferencesLocked(
    db: AgentMessagingDb,
    now: string,
  ): Promise<{ conferences_adjourned: number; dispatches_expired: number }> {
    const overdue = await db
      .select({ value: count() })
      .from(agentBusConferences)
      .where(and(ne(agentBusConferences.status, 'adjourned'), lte(agentBusConferences.deadlineAt, now)));
    await db
      .update(agentBusConferences)
      .set({ status: 'adjourned', adjournReason: 'Conference deadline passed', adjournedAt: now, pin: null, pinExpiresAt: null, updatedAt: now })
      .where(and(ne(agentBusConferences.status, 'adjourned'), lte(agentBusConferences.deadlineAt, now)));

    // A member whose task never came back returns to the floor rather than
    // vanishing: the chair can see the miss in `last_report_at` staying null and
    // decide whether to re-dispatch. Silently dropping it would hide the failure.
    const stranded = await db
      .select({ value: count() })
      .from(agentBusConferenceMembers)
      .where(and(eq(agentBusConferenceMembers.state, 'dispatched'), isNotNull(agentBusConferenceMembers.dispatchDeadlineAt), lte(agentBusConferenceMembers.dispatchDeadlineAt, now)));
    await db
      .update(agentBusConferenceMembers)
      .set({ state: 'seated', dispatchMessageId: null, dispatchDeadlineAt: null, updatedAt: now })
      .where(and(eq(agentBusConferenceMembers.state, 'dispatched'), isNotNull(agentBusConferenceMembers.dispatchDeadlineAt), lte(agentBusConferenceMembers.dispatchDeadlineAt, now)));

    // A graceful adjourn parks the room in `adjourning` while its last tasks run
    // out. Once none are left, nothing else is going to finish the job.
    const draining = await db
      .select({ id: agentBusConferences.id })
      .from(agentBusConferences)
      .where(eq(agentBusConferences.status, 'adjourning'))
      .for('update');
    let settled = 0;
    for (const row of draining) {
      const busy = await db
        .select({ value: count() })
        .from(agentBusConferenceMembers)
        .where(and(eq(agentBusConferenceMembers.conferenceId, row.id), eq(agentBusConferenceMembers.state, 'dispatched')));
      if (Number(busy[0]?.value ?? 0) > 0) continue;
      await db
        .update(agentBusConferences)
        .set({ status: 'adjourned', adjournedAt: now, pin: null, pinExpiresAt: null, updatedAt: now })
        .where(eq(agentBusConferences.id, row.id));
      await db
        .update(agentBusConferenceMembers)
        .set({ state: 'left', leftAt: now, updatedAt: now })
        .where(and(eq(agentBusConferenceMembers.conferenceId, row.id), ne(agentBusConferenceMembers.state, 'left')));
      settled += 1;
    }
    return {
      conferences_adjourned: Number(overdue[0]?.value ?? 0) + settled,
      dispatches_expired: Number(stranded[0]?.value ?? 0),
    };
  }
}

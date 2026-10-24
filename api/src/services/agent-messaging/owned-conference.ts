import { stageRoomEvent } from '../../control-plane/state/room-heads.js';
import { stageCancelOwnedConversation } from './owned-cancel.js';
import { randomInt, randomUUID } from 'node:crypto';
import {
  agentBusConferences,
  agentBusConferenceMembers,
  agentBusConversations,
  agentRoomEvents,
  agentRoomDeliveries,
  type AgentBusConference,
  type AgentBusConferenceMember,
  type AgentBusAddress,
  type AgentBusConversation,
} from '../../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import { sha256 } from '../../security/hash.js';
import { nowIso, isoOffsetSeconds } from '../../util/timestamp.js';
import type { Json } from '../../control-plane/commands.js';
import {
  mutateOwnerState,
  type OwnerRuntime,
  type OwnerMutationContext,
} from '../../control-plane/state/runtime.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import { ownedAddress, ownedBridge } from '../../control-plane/state/messaging.js';
import { ownedAddressPresence } from '../../control-plane/state/presence-notices.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { stageQueuedMessage } from '../../control-plane/state/messages.js';
import { stageConferenceCharge } from './owned-delivery.js';
import { resolveOwnedRecipient } from './owned-send.js';
import { SERVER_ADDRESS_ID } from './groups.js';
import { conferenceEnvelope, conferenceInviteBody, conferenceMessageExpiry } from './conference-protocol.js';
import {
  normalizeConferencePin,
  normalizeConferenceMaxMembers,
  normalizeConferenceTtl,
  normalizeDispatchEta,
  dispatchGraceSeconds,
  normalizeMessageBody,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeUuid,
} from './normalize.js';
import {
  AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP as BUDGET,
  AGENT_MESSAGING_CONFERENCE_PIN_SPACE as PIN_SPACE,
  AGENT_MESSAGING_MAX_BODY_BYTES,
} from './constants.js';
import { publicAddress, publicConferenceMember, newQueuedMessage } from './views.js';
import { errorCodeOf, errorMessageOf } from './internals.js';
import { wsPublisher } from '../../ws/publisher.js';

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const mode = (address: AgentBusAddress) => (address.currentSessionId ? 'attached' : 'headless');
function self(snapshot: OwnerStateSnapshot, id: string, token: string) {
  const session = ownedBridge(snapshot, id, token).session;
  if (!session.agentBusAddressId)
    throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
  const address = ownedAddress(snapshot, session.agentBusAddressId);
  if (address.currentSessionId !== id || address.bindingGeneration !== session.bindingGeneration)
    throw new ConflictError('Address binding changed', 'agent_messaging_binding_stale');
  return { session, address };
}
export function ownedConference(snapshot: OwnerStateSnapshot, id: string, open = false): AgentBusConference {
  const row = snapshot.table('agentBusConferences').get(id);
  if (!row) throw new NotFoundError('Conference not found', 'agent_messaging_conference_not_found');
  if (open && row.status !== 'open')
    throw new ConflictError('Conference is adjourned', 'agent_messaging_conference_adjourned');
  if (open && row.deadlineAt <= nowIso())
    throw new ConflictError('Conference deadline has passed', 'agent_messaging_conference_expired');
  return row;
}
export function ownedConferenceMember(
  snapshot: OwnerStateSnapshot,
  id: string,
  addressId: string,
  chair = false,
): AgentBusConferenceMember {
  const row = snapshot
    .table('agentBusConferenceMembers')
    .by('conferenceId', id)
    .find((m) => m.addressId === addressId && m.state !== 'left');
  if (!row)
    throw new ForbiddenError('Not a member of this conference', 'agent_messaging_conference_not_member');
  if (chair && row.role !== 'owner')
    throw new ForbiddenError('Only the conference owner can do that', 'agent_messaging_conference_not_owner');
  return row;
}
function roster(snapshot: OwnerStateSnapshot, id: string) {
  return snapshot
    .table('agentBusConferenceMembers')
    .by('conferenceId', id)
    .filter((m) => m.state !== 'left')
    .sort((a, b) => (a.joinedAt ?? '').localeCompare(b.joinedAt ?? ''))
    .flatMap((member) => {
      const address = snapshot.addresses.get(member.addressId),
        host = address ? snapshot.hosts.get(address.hostId) : undefined;
      return address && host ? [{ member, address, fqdn: host.fqdn }] : [];
    });
}
function freePin(ctx: OwnerMutationContext, now: string): string {
  const occupied = new Set<string>();
  for (const room of ctx.draft.table('agentBusConferences').all())
    if (room.pin) {
      if (room.pinExpiresAt && room.pinExpiresAt <= now)
        stageUpdate(ctx, 'agentBusConferences', room.id, { pin: null, pinExpiresAt: null, updatedAt: now });
      else occupied.add(room.pin);
    }
  const free: string[] = [];
  for (let n = 0; n < PIN_SPACE; n++) {
    const pin = String(n).padStart(4, '0');
    if (!occupied.has(pin)) free.push(pin);
  }
  if (!free.length)
    throw new ConflictError('No conference PIN is available', 'agent_messaging_conference_pin_exhausted');
  return free[randomInt(free.length)]!;
}
function insertMember(ctx: OwnerMutationContext, row: AgentBusConferenceMember) {
  ctx.draft.upsert('agentBusConferenceMembers', row);
  ctx.write(async (tx) => {
    await tx.insert(agentBusConferenceMembers).values(row);
  });
  return row;
}
function memberRow(
  conferenceId: string,
  address: AgentBusAddress,
  now: string,
  role = 'participant',
): AgentBusConferenceMember {
  return {
    id: randomUUID(),
    conferenceId,
    addressId: address.id,
    launchName: address.launchName,
    requestedTarget: null,
    conversationId: null,
    role,
    purpose: null,
    mode: mode(address),
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
  };
}
/** One spoke's metadata, body and budget change share its caller's command. */
export function stageConferenceMessage(
  ctx: OwnerMutationContext,
  keyring: Keyring,
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
    charge?: boolean;
  },
) {
  const { conference, member, sender, target, now } = input;
  if (member.messageCount >= BUDGET)
    throw new ConflictError(
      `Conference budget spent (${BUDGET} messages)`,
      'agent_messaging_conference_budget_spent',
    );
  let conversation: AgentBusConversation;
  if (member.conversationId) {
    const row = ctx.draft.table('agentBusConversations').get(member.conversationId);
    if (!row) throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
    conversation = row;
  } else {
    conversation = {
      id: randomUUID(),
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
    };
    ctx.draft.upsert('agentBusConversations', conversation);
    const created = conversation;
    ctx.write(async (tx) => {
      await tx.insert(agentBusConversations).values(created);
    });
    stageUpdate(ctx, 'agentBusConferenceMembers', member.id, {
      conversationId: conversation.id,
      updatedAt: now,
    });
  }
  if (conversation.status !== 'open')
    throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
  if (
    ![conversation.addressAId, conversation.addressBId].includes(sender.id) ||
    ![conversation.addressAId, conversation.addressBId].includes(target.id)
  )
    throw new ForbiddenError('Conversation participants changed', 'agent_messaging_conversation_mismatch');
  const content = conferenceEnvelope(input.verb, { conference: conference.id, ...input.headers }, input.body),
    id = randomUUID();
  const message = stageQueuedMessage(
    ctx,
    newQueuedMessage({
      id,
      conversationId: conversation.id,
      sequence: conversation.nextSequence,
      sender,
      senderSessionId: input.senderSessionId,
      target,
      kind: input.verb === 'TASK' ? 'task' : 'message',
      deliveryClass: input.verb === 'TASK' ? 'information' : 'coordination',
      content,
      contentEnc: encrypt(content, keyring),
      clientMessageId: randomUUID(),
      expiresAt: conferenceMessageExpiry(conference, now),
      now,
    }),
  );
  stageUpdate(ctx, 'agentBusConversations', conversation.id, {
    nextSequence: conversation.nextSequence + 1,
    lastActivityAt: now,
    updatedAt: now,
  });
  stageUpdate(ctx, 'agentBusConferenceMembers', member.id, {
    mode: mode(sender.id === conference.ownerAddressId ? target : sender),
    updatedAt: now,
  });
  if (input.charge !== false) stageConferenceCharge(ctx, conversation.id, now);
  return { id, conversationId: conversation.id, message };
}

/** Reads have no reconciliation side effects; all real deadlines are checked here. */
export class OwnedConferences {
  constructor(
    private runtime: OwnerRuntime,
    private keyring: Keyring,
  ) {}
  private snapshot() {
    this.runtime.assertOwner();
    return this.runtime.state.snapshot();
  }
  private changed(id: string) {
    wsPublisher.publish('agent_messaging.conference.changed', { conference_id: id });
  }
  async open(
    id: string,
    token: string,
    input: {
      topic?: string | null;
      purpose?: string | null;
      ttlSeconds?: number | null;
      maxMembers?: number | null;
    } = {},
  ) {
    const topic = normalizeOptionalText(input.topic, 255),
      purpose = normalizeOptionalText(input.purpose, 1024),
      ttl = normalizeConferenceTtl(input.ttlSeconds),
      maxMembers = normalizeConferenceMaxMembers(input.maxMembers);
    const initial = this.snapshot(),
      first = self(initial, id, token);
    const existing = initial
      .table('agentBusConferences')
      .by('ownerAddressId', first.address.id)
      .find((c) => c.status === 'open' && c.deadlineAt > nowIso());
    if (existing?.pin && existing.pinExpiresAt && existing.pinExpiresAt > nowIso())
      return this.openView(initial, existing, first.address, true);
    const result = await mutateOwnerState(this.runtime, {
      kind: 'conference.open',
      payload: json({ id, topic, purpose, ttl, maxMembers }),
      authorize: (s) => {
        self(s, id, token);
      },
      prepare: (ctx) => {
        const { address } = self(ctx.snapshot, id, token),
          now = nowIso();
        const old = ctx.snapshot
          .table('agentBusConferences')
          .by('ownerAddressId', address.id)
          .find((c) => c.status === 'open' && c.deadlineAt > now);
        const pin = freePin(ctx, now);
        if (old) {
          const updated = stageUpdate(ctx, 'agentBusConferences', old.id, {
            pin,
            pinExpiresAt: old.deadlineAt,
            updatedAt: now,
          });
          return json(this.openView(ctx.draft.view(), updated, address, true));
        }
        const deadline = isoOffsetSeconds(ttl),
          room: AgentBusConference = {
            id: randomUUID(),
            ownerAddressId: address.id,
            ownerAdminId: null,
            topic,
            purpose,
            pin,
            pinExpiresAt: deadline,
            status: 'open',
            maxMembers,
            deadlineAt: deadline,
            adjournReason: null,
            adjournedAt: null,
            createdAt: now,
            updatedAt: now,
          };
        ctx.draft.upsert('agentBusConferences', room);
        ctx.write(async (tx) => {
          await tx.insert(agentBusConferences).values(room);
        });
        insertMember(ctx, { ...memberRow(room.id, address, now, 'owner'), purpose });
        return json(this.openView(ctx.draft.view(), room, address, false));
      },
    });
    this.changed(String((result as Record<string, Json>).conference_id));
    return result as Record<string, unknown>;
  }
  private openView(
    snapshot: OwnerStateSnapshot,
    room: AgentBusConference,
    address: AgentBusAddress,
    reused: boolean,
  ) {
    return {
      enabled: true,
      conference_id: room.id,
      pin: room.pin,
      expires_at: room.deadlineAt,
      deadline_at: room.deadlineAt,
      topic: room.topic,
      max_members: room.maxMembers,
      reused,
      self: publicAddress(address),
      roster: roster(snapshot, room.id).map((r) => publicConferenceMember(r.member, r.address, r.fqdn)),
    };
  }
  async invite(
    id: string,
    token: string,
    input: { conferenceId: string; to: string[]; note?: string | null },
  ) {
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id'),
      note = normalizeOptionalText(input.note, AGENT_MESSAGING_MAX_BODY_BYTES) ?? '';
    if (!Array.isArray(input.to) || !input.to.length)
      throw new ValidationError('to must be a non-empty list of addresses', { param: 'to' });
    const targets = input.to.map((t) => normalizeRequiredText(t, 'to', 96)),
      results: Record<string, unknown>[] = [];
    for (const target of targets)
      try {
        const result = await mutateOwnerState(this.runtime, {
          kind: 'conference.invite',
          payload: { id, conferenceId, target, note },
          authorize: (s) => {
            const me = self(s, id, token);
            ownedConference(s, conferenceId, true);
            ownedConferenceMember(s, conferenceId, me.address.id, true);
          },
          prepare: (ctx) => {
            const { address: chair } = self(ctx.snapshot, id, token),
              room = ownedConference(ctx.snapshot, conferenceId, true),
              now = nowIso();
            const previous = ctx.snapshot
              .table('agentBusConferenceMembers')
              .by('conferenceId', conferenceId)
              .find((m) => m.requestedTarget === target.trim().toLowerCase());
            const invitee = previous
              ? ownedAddress(ctx.snapshot, previous.addressId)
              : resolveOwnedRecipient(ctx.snapshot, target);
            ownedAddress(ctx.snapshot, invitee.id);
            if (invitee.id === chair.id)
              throw new ValidationError('The chair is already in the conference', { param: 'to' });
            if (ctx.snapshot.hosts.get(invitee.hostId)?.internalRole)
              throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
            const members = ctx.snapshot.table('agentBusConferenceMembers').by('conferenceId', conferenceId),
              count = members.filter((m) => m.state !== 'left').length;
            const prior = members.find((m) => m.addressId === invitee.id);
            if (prior && prior.state !== 'left')
              throw new ConflictError(
                'Address is already a member',
                'agent_messaging_conference_already_member',
              );
            if (count >= room.maxMembers)
              throw new ConflictError('Conference is full', 'agent_messaging_conference_full');
            const row = {
              ...memberRow(conferenceId, invitee, now),
              id: prior?.id ?? randomUUID(),
              conversationId: prior?.conversationId ?? null,
              requestedTarget: target.trim().toLowerCase(),
              state: 'invited',
              messageCount: prior?.messageCount ?? 0,
              joinedAt: null,
              createdAt: prior?.createdAt ?? now,
            };
            const member = prior
              ? stageUpdate(ctx, 'agentBusConferenceMembers', prior.id, row)
              : insertMember(ctx, row);
            const sent = stageConferenceMessage(ctx, this.keyring, {
              conference: room,
              member,
              sender: chair,
              target: invitee,
              senderSessionId: id,
              verb: 'INVITE',
              headers: {
                topic: room.topic ?? undefined,
                deadline: room.deadlineAt,
                members: `${count + 1}/${room.maxMembers}`,
              },
              body: conferenceInviteBody(room, note),
              now,
              charge: false,
            });
            return {
              address: invitee.address,
              name: invitee.launchName ?? null,
              alias: invitee.displayAlias,
              mode: mode(invitee),
              delivered: true,
              message_id: sent.id,
            };
          },
        });
        results.push(result as Record<string, unknown>);
      } catch (error) {
        results.push({
          address: target,
          delivered: false,
          error: errorCodeOf(error),
          detail: errorMessageOf(error),
        });
      }
    this.changed(conferenceId);
    return { enabled: true, conference_id: conferenceId, results };
  }
  async join(
    id: string,
    token: string,
    input: {
      pin?: string | null;
      conferenceId?: string | null;
      purpose?: string | null;
      content?: string | null;
    },
  ) {
    const hasPin = !!input.pin,
      hasId = !!input.conferenceId;
    if (hasPin === hasId)
      throw new ValidationError('Provide exactly one of pin or conference_id', { param: 'pin' });
    const pin = hasPin ? normalizeConferencePin(input.pin) : null,
      roomId = hasId ? normalizeUuid(input.conferenceId, 'conference_id') : null,
      purpose = normalizeOptionalText(input.purpose, 1024),
      body = normalizeOptionalText(input.content, AGENT_MESSAGING_MAX_BODY_BYTES) ?? '';
    let chairId: string | undefined;
    const result = await mutateOwnerState(this.runtime, {
      kind: 'conference.join',
      payload: json({ id, pin, roomId, purpose, body }),
      authorize: (s) => {
        self(s, id, token);
        if (chairId && ownedAddressPresence(this.runtime, s, ownedAddress(s, chairId)) !== 'listening')
          throw new ConflictError(
            'Conference chair is not listening',
            'agent_messaging_conference_chair_not_listening',
          );
      },
      prepare: (ctx) => {
        const { address } = self(ctx.snapshot, id, token),
          now = nowIso();
        const selected = pin
          ? ctx.snapshot
              .table('agentBusConferences')
              .all()
              .find((c) => c.pin === pin && !!c.pinExpiresAt && c.pinExpiresAt > now)?.id
          : roomId;
        if (!selected)
          throw new NotFoundError(
            'Conference PIN not found or expired',
            'agent_messaging_conference_pin_not_found',
          );
        const room = ownedConference(ctx.snapshot, selected, true),
          chair = ownedAddress(ctx.snapshot, room.ownerAddressId);
        chairId = chair.id;
        if (chair.id === address.id)
          throw new ValidationError('The chair is already in the conference', { param: 'pin' });
        if (ownedAddressPresence(this.runtime, ctx.snapshot, chair) !== 'listening')
          throw new ConflictError(
            'The conference chair has no live receiver',
            'agent_messaging_conference_chair_not_listening',
          );
        const members = ctx.snapshot.table('agentBusConferenceMembers').by('conferenceId', room.id),
          prior = members.find((m) => m.addressId === address.id);
        if ((!prior || prior.state === 'left') && !pin)
          throw new ForbiddenError('Not invited to this conference', 'agent_messaging_conference_not_member');
        if (
          (!prior || prior.state === 'left') &&
          members.filter((m) => m.state !== 'left').length >= room.maxMembers
        )
          throw new ConflictError('Conference is full', 'agent_messaging_conference_full');
        const member = prior
          ? stageUpdate(ctx, 'agentBusConferenceMembers', prior.id, {
              state: prior.state === 'dispatched' ? 'dispatched' : 'seated',
              joinedAt: ['invited', 'left'].includes(prior.state) ? now : prior.joinedAt,
              purpose: purpose ?? prior.purpose,
              mode: mode(address),
              leftAt: null,
              updatedAt: now,
            })
          : insertMember(ctx, { ...memberRow(room.id, address, now), purpose });
        stageConferenceMessage(ctx, this.keyring, {
          conference: room,
          member,
          sender: address,
          target: chair,
          senderSessionId: id,
          verb: 'HELLO',
          headers: { purpose: purpose ?? undefined },
          body,
          now,
        });
        return json({
          enabled: true,
          conference_id: room.id,
          topic: room.topic,
          deadline_at: room.deadlineAt,
          chair: publicAddress(chair),
          self: publicAddress(address),
          roster: roster(ctx.draft.view(), room.id).map((r) =>
            publicConferenceMember(r.member, r.address, r.fqdn),
          ),
        });
      },
    });
    this.changed(String((result as Record<string, Json>).conference_id));
    return result as Record<string, unknown>;
  }
  roster(id: string, token: string, raw: string) {
    const snapshot = this.snapshot(),
      { address } = self(snapshot, id, token),
      room = ownedConference(snapshot, normalizeUuid(raw, 'conference_id'));
    ownedConferenceMember(snapshot, room.id, address.id);
    return {
      enabled: true,
      conference_id: room.id,
      topic: room.topic,
      purpose: room.purpose,
      status: room.status,
      deadline_at: room.deadlineAt,
      max_members: room.maxMembers,
      members: roster(snapshot, room.id).map((r) => publicConferenceMember(r.member, r.address, r.fqdn)),
    };
  }
  list(id: string, token: string) {
    const snapshot = this.snapshot(),
      { address } = self(snapshot, id, token),
      now = nowIso();
    return {
      enabled: true,
      conferences: snapshot
        .table('agentBusConferenceMembers')
        .by('addressId', address.id)
        .filter((m) => m.state !== 'left')
        .flatMap((member) => {
          const room = snapshot.table('agentBusConferences').get(member.conferenceId);
          if (!room || room.status === 'adjourned' || room.deadlineAt <= now) return [];
          const chair = snapshot.addresses.get(room.ownerAddressId);
          return [
            {
              conference_id: room.id,
              topic: room.topic,
              purpose: room.purpose,
              status: room.status,
              deadline_at: room.deadlineAt,
              created_at: room.createdAt,
              max_members: room.maxMembers,
              member_count: roster(snapshot, room.id).length,
              chair: chair
                ? {
                    address: chair.address,
                    name: chair.launchName ?? null,
                    alias: chair.displayAlias,
                    engine: chair.engine,
                    fqdn: snapshot.hosts.get(chair.hostId)?.fqdn ?? null,
                  }
                : null,
              role: member.role,
              state: member.state,
              messages_used: member.messageCount,
              messages_budget: BUDGET,
            },
          ];
        })
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, 50),
    };
  }
  async say(id: string, token: string, input: { conferenceId: string; content: string; to?: string | null }) {
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id'),
      body = normalizeMessageBody(input.content),
      to = normalizeOptionalText(input.to, 96),
      eventId = randomUUID();
    const plan = (await mutateOwnerState(this.runtime, {
      kind: 'conference.say',
      payload: { id, conferenceId, body, to },
      authorize: (s) => {
        const me = self(s, id, token);
        ownedConference(s, conferenceId, true);
        ownedConferenceMember(s, conferenceId, me.address.id);
      },
      prepare: (ctx) => {
        const { session, address } = self(ctx.snapshot, id, token),
          room = ownedConference(ctx.snapshot, conferenceId, true),
          member = ownedConferenceMember(ctx.snapshot, conferenceId, address.id);
        if (member.state === 'invited')
          throw new ConflictError('Join before speaking', 'agent_messaging_conference_not_joined');
        const event = {
          id: eventId,
          roomId: conferenceId,
          actor: `agent:${address.id}`,
          requestId: eventId,
          payloadHash: sha256(body),
          bodyEnc: encrypt(
            JSON.stringify({
              name: session.launchName ?? 'Conference participant',
              content: body,
              attachments: [],
              kind: 'chat',
            }),
            this.keyring,
          ),
          createdAt: nowIso(),
        };
        stageRoomEvent(ctx, event);
        const targets =
          member.role === 'owner'
            ? roster(ctx.snapshot, conferenceId)
                .filter(
                  (r) =>
                    r.member.role !== 'owner' &&
                    r.member.state === 'seated' &&
                    (!to || r.address.address === to || r.address.displayAlias === to),
                )
                .map((r) => r.address.id)
            : [room.ownerAddressId];
        return { targets };
      },
    })) as { targets: string[] };
    const results: Record<string, unknown>[] = [];
    for (const targetId of plan.targets)
      try {
        const sent = await mutateOwnerState(this.runtime, {
          kind: 'conference.say.deliver',
          payload: { id, conferenceId, targetId, eventId, body },
          authorize: (s) => {
            self(s, id, token);
            ownedConference(s, conferenceId, true);
            ownedAddress(s, targetId);
          },
          prepare: (ctx) => {
            const { address } = self(ctx.snapshot, id, token),
              room = ownedConference(ctx.snapshot, conferenceId, true),
              other = ownedAddress(ctx.snapshot, targetId),
              member = ownedConferenceMember(
                ctx.snapshot,
                conferenceId,
                address.id === room.ownerAddressId ? other.id : address.id,
              ),
              now = nowIso();
            const message = stageConferenceMessage(ctx, this.keyring, {
              conference: room,
              member,
              sender: address,
              target: other,
              senderSessionId: id,
              verb: 'SAY',
              headers: {},
              body,
              now,
            });
            const delivery = { eventId, addressId: other.id, messageId: message.id, reason: null };
            ctx.draft.upsert('agentRoomDeliveries', delivery);
            ctx.write(async (tx) => {
              await tx.insert(agentRoomDeliveries).values(delivery);
            });
            return {
              address: other.address,
              alias: other.displayAlias,
              delivered: true,
              message_id: message.id,
            };
          },
        });
        results.push(sent as Record<string, unknown>);
      } catch (error) {
        results.push({
          address: targetId,
          delivered: false,
          error: errorCodeOf(error),
          detail: errorMessageOf(error),
        });
      }
    wsPublisher.publish('agent_room_chat.changed', { room_id: conferenceId });
    this.changed(conferenceId);
    return { enabled: true, conference_id: conferenceId, results };
  }
  async dispatch(
    id: string,
    token: string,
    input: { conferenceId: string; to: string; task: string; etaSeconds?: number | null },
  ) {
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id'),
      to = normalizeRequiredText(input.to, 'to', 96),
      task = normalizeMessageBody(input.task),
      eta = normalizeDispatchEta(input.etaSeconds),
      grace = dispatchGraceSeconds(eta);
    const result = await mutateOwnerState(this.runtime, {
      kind: 'conference.dispatch',
      payload: { id, conferenceId, to, task, eta },
      authorize: (s) => {
        const me = self(s, id, token);
        ownedConference(s, conferenceId, true);
        ownedConferenceMember(s, conferenceId, me.address.id, true);
      },
      prepare: (ctx) => {
        const { address } = self(ctx.snapshot, id, token),
          room = ownedConference(ctx.snapshot, conferenceId, true),
          target = resolveOwnedRecipient(ctx.snapshot, to),
          member = ownedConferenceMember(ctx.snapshot, conferenceId, target.id),
          now = nowIso();
        ownedAddress(ctx.snapshot, target.id);
        if (member.role === 'owner')
          throw new ValidationError('The chair cannot dispatch itself', { param: 'to' });
        if (member.state === 'invited')
          throw new ConflictError('Member has not joined', 'agent_messaging_conference_not_joined');
        if (member.state === 'dispatched')
          throw new ConflictError('Member is already on a task', 'agent_messaging_conference_member_busy');
        const message = stageConferenceMessage(ctx, this.keyring, {
          conference: room,
          member,
          sender: address,
          target,
          senderSessionId: id,
          verb: 'TASK',
          headers: { eta, deadline: room.deadlineAt },
          body: task,
          now,
        });
        const deadline = new Date(
          Math.min(Date.parse(now) + grace * 1000, Date.parse(room.deadlineAt)),
        ).toISOString();
        // A spent spoke cannot be resurrected by dispatch's second metadata update.
        const after = ctx.draft.table('agentBusConferenceMembers').get(member.id)!;
        if (after.state !== 'left')
          stageUpdate(ctx, 'agentBusConferenceMembers', member.id, {
            state: 'dispatched',
            dispatchMessageId: message.id,
            dispatchDeadlineAt: deadline,
            dispatchedAt: now,
            updatedAt: now,
          });
        return json({
          enabled: true,
          conference_id: conferenceId,
          dispatched_to: publicAddress(target),
          message_id: message.id,
          eta_seconds: eta,
          grace_seconds: grace,
          dispatch_deadline_at: deadline,
        });
      },
    });
    this.changed(conferenceId);
    return result as Record<string, unknown>;
  }
  async adjourn(
    id: string,
    token: string,
    input: { conferenceId: string; reason?: string | null; force?: boolean },
  ) {
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id'),
      reason = normalizeOptionalText(input.reason, 255) ?? 'Adjourned by the chair',
      force = input.force === true;
    const result = await mutateOwnerState(this.runtime, {
      kind: 'conference.adjourn',
      payload: { id, conferenceId, reason, force },
      authorize: (s) => {
        const me = self(s, id, token);
        ownedConferenceMember(s, conferenceId, me.address.id, true);
      },
      prepare: (ctx) => {
        const { address } = self(ctx.snapshot, id, token),
          room = ownedConference(ctx.snapshot, conferenceId),
          now = nowIso();
        if (room.status === 'adjourned')
          throw new ConflictError('Conference is already adjourned', 'agent_messaging_conference_adjourned');
        const participants = roster(ctx.snapshot, conferenceId).filter((r) => r.member.role !== 'owner'),
          working = participants.filter((r) => r.member.state === 'dispatched');
        const answering = new Set<string>();
        for (const event of ctx.snapshot.table('agentRoomEvents').by('roomId', conferenceId))
          for (const delivery of ctx.snapshot.table('agentRoomDeliveries').by('eventId', event.id)) {
            const m = delivery.messageId ? ctx.snapshot.messages.get(delivery.messageId) : undefined;
            if (
              m?.senderAddressId === SERVER_ADDRESS_ID &&
              !['completed', 'dead', 'expired', 'canceled', 'ambiguous'].includes(m.status)
            )
              answering.add(delivery.addressId);
          }
        const releasable = force
            ? participants
            : participants.filter((r) => r.member.state !== 'dispatched' && !answering.has(r.address.id)),
          settled = force || (!working.length && !answering.size);
        stageUpdate(ctx, 'agentBusConferences', room.id, {
          status: settled ? 'adjourned' : 'adjourning',
          adjournReason: reason,
          adjournedAt: settled ? now : null,
          pin: null,
          pinExpiresAt: null,
          updatedAt: now,
        });
        let released = 0,
          uncertain = 0;
        for (const row of releasable) {
          stageUpdate(ctx, 'agentBusConferenceMembers', row.member.id, {
            state: 'left',
            leftAt: now,
            dispatchMessageId: null,
            dispatchDeadlineAt: null,
            updatedAt: now,
          });
          if (row.member.conversationId) {
            const canceled = stageCancelOwnedConversation(
              ctx,
              row.member.conversationId,
              `agent:${address.id}`,
              reason,
              now,
            );
            released++;
            uncertain += canceled.uncertain_deliveries;
          }
        }
        if (settled)
          for (const member of ctx.draft.table('agentBusConferenceMembers').by('conferenceId', room.id))
            if (member.state !== 'left')
              stageUpdate(ctx, 'agentBusConferenceMembers', member.id, {
                state: 'left',
                leftAt: now,
                updatedAt: now,
              });
        return {
          enabled: true,
          conference_id: room.id,
          status: settled ? 'adjourned' : 'adjourning',
          released,
          interrupted_tasks: force ? working.length : 0,
          waiting_on_tasks: settled ? 0 : working.length,
          uncertain_deliveries: uncertain,
        };
      },
    });
    this.changed(conferenceId);
    return result as Record<string, unknown>;
  }
}

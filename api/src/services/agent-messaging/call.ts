/**
 * Live 1:1 calls and the four-digit PIN rendezvous they meet on.
 *
 * Split out of `../agent-messaging.ts`. The PIN space is shared with
 * conferences -- one namespace, one sweep -- so the three primitives that
 * manage it are public on the coordinator and the conference code borrows them
 * through its own core interface rather than keeping a second registry.
 */

import { randomInt, randomUUID } from 'node:crypto';

import { and, eq, gt, isNotNull, lte } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import {
  agentBusAddresses,
  agentBusConferences,
  agentBusConversations,
  agentBusMessages,
  type AgentBusAddress,
  type AgentBusConversation,
  type AgentSession,
  type Host,
} from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import {
  AGENT_MESSAGING_CALL_PIN_SPACE,
} from './constants.js';
import {
  normalizeCallPin,
  normalizeCallPinTtl,
  normalizeMessageBody,
  normalizeMessageTtl,
  normalizeUuid,
} from './normalize.js';
import type { AgentMessagingDb } from './types.js';
import { messageForParticipant, newQueuedMessage, publicAddress } from './views.js';

/** What a call borrows from the bus: identity, eligibility, and the audit log. */
export interface CallCore {
  readonly db: Database;
  readonly keyring: Keyring;
  requireEnabledLocked(db: AgentMessagingDb): Promise<void>;
  requireAddressLocked(db: AgentMessagingDb, id: string): Promise<AgentBusAddress>;
  authenticateBridge(
    sessionId: string,
    rawToken: string,
    allowEnded?: boolean,
  ): Promise<{ session: AgentSession; host: Host }>;
  assertSessionAddressLocked(db: AgentMessagingDb, sessionId: string, address: AgentBusAddress): Promise<void>;
  assertAddressEligibleLocked(db: AgentMessagingDb, address: AgentBusAddress): Promise<void>;
  recordRuntime(action: string, hostId: number | null, engine: string, details: Record<string, unknown>): Promise<void>;
}

export class CallCoordinator {
  constructor(private readonly core: CallCore) {}

  /**
   * Clear every PIN whose window has closed.
   *
   * Runs before any mint or redeem, and again on the maintenance tick. An
   * expired-but-uncleared PIN still occupies its slot in the unique index, so
   * without this the mint-from-complement scan would treat a dead rendezvous as
   * a live one.
   */
  async sweepCallPinsLocked(db: AgentMessagingDb, now: string): Promise<void> {
    await db
      .update(agentBusAddresses)
      .set({ callPin: null, callPinExpiresAt: null, updatedAt: now })
      .where(and(isNotNull(agentBusAddresses.callPin), lte(agentBusAddresses.callPinExpiresAt, now)));
    // Conference PINs share the four-digit space and therefore the sweep. A dead
    // room PIN left in place would occupy a slot the call mint cannot reuse.
    await db
      .update(agentBusConferences)
      .set({ pin: null, pinExpiresAt: null, updatedAt: now })
      .where(and(isNotNull(agentBusConferences.pin), lte(agentBusConferences.pinExpiresAt, now)));
  }

  /**
   * Every PIN currently spoken for, across both rendezvous kinds.
   *
   * The two spaces are deliberately one space. A human carrying four digits from
   * one terminal to another cannot be expected to also carry which *kind* of
   * thing those digits open, and `#call receiver 4821` against a conference PIN
   * should fail as "wrong kind" rather than silently dial an unrelated stranger
   * who happens to hold the same number. MySQL cannot express a UNIQUE across
   * two tables, so the invariant lives here, in the mint.
   */
  async livePinsLocked(db: AgentMessagingDb): Promise<Set<string>> {
    const addressRows = await db
      .select({ pin: agentBusAddresses.callPin })
      .from(agentBusAddresses)
      .where(isNotNull(agentBusAddresses.callPin))
      .for('update');
    const conferenceRows = await db
      .select({ pin: agentBusConferences.pin })
      .from(agentBusConferences)
      .where(isNotNull(agentBusConferences.pin))
      .for('update');
    return new Set(
      [...addressRows, ...conferenceRows].map((row) => row.pin).filter((pin): pin is string => pin !== null),
    );
  }

  /**
   * Choose from the complement of the live set rather than retrying random
   * values against a unique index: a duplicate insert inside a transaction would
   * surface as a driver-level ER_DUP_ENTRY this layer would have to
   * pattern-match, and exhaustion would be indistinguishable from bad luck.
   */
  pickFreePin(taken: Set<string>): string {
    const free: string[] = [];
    for (let candidate = 0; candidate < AGENT_MESSAGING_CALL_PIN_SPACE; candidate += 1) {
      const pin = String(candidate).padStart(4, '0');
      if (!taken.has(pin)) free.push(pin);
    }
    if (free.length === 0) {
      throw new ConflictError('No call PIN is available', 'agent_messaging_call_pin_exhausted');
    }
    return free[randomInt(free.length)]!;
  }

  /** Pick a free PIN and bind it to this address. */
  private async mintCallPinLocked(
    db: AgentMessagingDb,
    addressId: string,
    expiresAt: string,
    now: string,
  ): Promise<string> {
    const pin = this.pickFreePin(await this.livePinsLocked(db));
    await db
      .update(agentBusAddresses)
      .set({ callPin: pin, callPinExpiresAt: expiresAt, updatedAt: now })
      .where(eq(agentBusAddresses.id, addressId));
    return pin;
  }


  /**
   * Resolve a PIN to the address that opened it.
   *
   * Deliberately does not clear the PIN: the caller clears it only once the join
   * has fully succeeded, so a join that fails validation, targets itself, or
   * finds an ineligible opener leaves the rendezvous intact. One mistyped join
   * must not burn a PIN the human is still holding.
   *
   * The failure names all three ways a lookup comes up empty rather than
   * guessing between them, because nothing here can tell them apart: a swept PIN
   * and a spent PIN both leave the same NULL, and the four-digit space is shared
   * with conferences and re-minted constantly, so any remembered "last PIN"
   * would sooner or later belong to a stranger. The third cause is the one worth
   * spelling out — a human who hands one PIN to a third agent reads "not found"
   * as a typo and re-reads the digits, when what they actually want is a
   * conference.
   */
  private async consumeCallPinLocked(db: AgentMessagingDb, pin: string, now: string): Promise<AgentBusAddress> {
    const rows = await db
      .select()
      .from(agentBusAddresses)
      .where(and(eq(agentBusAddresses.callPin, pin), gt(agentBusAddresses.callPinExpiresAt, now)))
      .limit(1)
      .for('update');
    const address = rows[0];
    if (!address || address.archivedAt) {
      throw new NotFoundError(
        'Call PIN not found, expired, or already dialled. A call PIN is single-use and joins exactly two agents; for three or more, open a conference instead.',
        'agent_messaging_call_pin_not_found',
      );
    }
    return address;
  }

  private async clearCallPinLocked(db: AgentMessagingDb, addressId: string, now: string): Promise<void> {
    await db
      .update(agentBusAddresses)
      .set({ callPin: null, callPinExpiresAt: null, updatedAt: now })
      .where(eq(agentBusAddresses.id, addressId));
  }

  /**
   * Open a `#call` rendezvous: mint a PIN a peer can dial, and tell the caller
   * its own address.
   *
   * `self` is the only route by which an agent learns its own address —
   * `listAddresses` excludes the caller by construction.
   */
  async openCall(
    sessionId: string,
    bridgeToken: string,
    input: { ttlSeconds?: number | null } = {},
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken);
    if (!authenticated.session.agentBusAddressId) {
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    }
    const ttlSeconds = normalizeCallPinTtl(input.ttlSeconds);
    const result = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const now = nowIso();
      await this.sweepCallPinsLocked(tx, now);
      const self = await this.core.requireAddressLocked(tx, authenticated.session.agentBusAddressId!);
      await this.core.assertSessionAddressLocked(tx, authenticated.session.id, self);
      await this.core.assertAddressEligibleLocked(tx, self);
      // Re-opening while a PIN is still live returns the same one. Minting a
      // second would silently kill a PIN the human may already have written down.
      if (self.callPin && self.callPinExpiresAt && self.callPinExpiresAt > now) {
        return { pin: self.callPin, expiresAt: self.callPinExpiresAt, reused: true, self };
      }
      const expiresAt = isoOffsetSeconds(ttlSeconds);
      const pin = await this.mintCallPinLocked(tx, self.id, expiresAt, now);
      return { pin, expiresAt, reused: false, self };
    });
    return {
      enabled: true,
      pin: result.pin,
      expires_at: result.expiresAt,
      reused: result.reused,
      self: publicAddress(result.self),
    };
  }

  /**
   * Dial a PIN: open the conversation and deliver the first message in one step.
   *
   * The hello is folded in for atomicity — PIN consumed, conversation opened and
   * first message queued all commit together. Split across two calls, a failed
   * follow-up send would leave a consumed single-use PIN, an orphan conversation
   * and an opener waiting on a rendezvous it can no longer be reached through.
   */
  async joinCall(
    sessionId: string,
    bridgeToken: string,
    input: { pin: string; content: string; clientMessageId: string; ttlSeconds?: number | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken);
    if (!authenticated.session.agentBusAddressId) {
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    }
    const pin = normalizeCallPin(input.pin);
    const content = normalizeMessageBody(input.content);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const ttlSeconds = normalizeMessageTtl(input.ttlSeconds);
    const result = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const now = nowIso();
      await this.sweepCallPinsLocked(tx, now);
      const opener = await this.consumeCallPinLocked(tx, pin, now);
      const self = await this.core.requireAddressLocked(tx, authenticated.session.agentBusAddressId!);
      await this.core.assertSessionAddressLocked(tx, authenticated.session.id, self);
      if (self.id === opener.id) {
        throw new ValidationError('An agent cannot call itself', { param: 'pin' });
      }
      await this.core.assertAddressEligibleLocked(tx, opener);

      const conversation: AgentBusConversation = {
        id: randomUUID(),
        addressAId: opener.id,
        addressBId: self.id,
        createdByAddressId: self.id,
        nextSequence: 1,
        status: 'open',
        lastActivityAt: now,
        canceledBy: null,
        cancelReason: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentBusConversations).values(conversation);
      const messageId = randomUUID();
      await tx.insert(agentBusMessages).values(
        newQueuedMessage({
          id: messageId,
          conversationId: conversation.id,
          sequence: 1,
          sender: self,
          senderSessionId: authenticated.session.id,
          target: opener,
          kind: 'message',
          content,
          contentEnc: encrypt(content, this.core.keyring),
          clientMessageId,
          expiresAt: isoOffsetSeconds(ttlSeconds),
          now,
        }),
      );
      const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1);
      const persisted = persistedRows[0];
      if (!persisted) throw new Error('Inserted agent message could not be read back');
      await tx
        .update(agentBusConversations)
        .set({ nextSequence: 2, lastActivityAt: now, updatedAt: now })
        .where(eq(agentBusConversations.id, conversation.id));
      // Single-use, and consumed only here — after every check has passed.
      await this.clearCallPinLocked(tx, opener.id, now);
      return { conversation, message: persisted, self, opener };
    });
    await this.core.recordRuntime('agent_message.queued', authenticated.host.id, result.self.engine, {
      message_id: result.message.id,
      conversation_id: result.message.conversationId,
      source_address_id: result.self.id,
      target_address_id: result.opener.id,
      source_engine: result.self.engine,
      target_engine: result.opener.engine,
      content_bytes: result.message.contentBytes,
    });
    wsPublisher.publish('agent_messaging.message.changed', {
      message_id: result.message.id,
      conversation_id: result.message.conversationId,
      status: result.message.status,
    });
    return {
      enabled: true,
      conversation_id: result.conversation.id,
      peer: publicAddress(result.opener),
      self: publicAddress(result.self),
      message: messageForParticipant(result.message, content, result.self, result.opener),
    };
  }
}

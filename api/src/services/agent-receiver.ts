import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { registerOwnedReceiver, updateOwnedReceiver, statusOwnedReceiver, assertOwnedReceiverClaim, retryOwnedReceiver } from '../control-plane/streams/receiver.js';
import { smartQueueAllowed, peerBatchAllowed } from './agent-messaging/smart-queue.js';
import { markWaitingForPresence } from './agent-messaging/presence-feedback.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentSessions, agentBusAddresses, hosts, versions } from '../db/schema.js';
import { AGENT_MESSAGING_ENABLED_KEY } from './agent-messaging/constants.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { ConflictError, ForbiddenError } from '../http/errors.js';
import { createAgentMessagingService } from './agent-messaging.js';
import { createAgentPortalService } from './agent-portal.js';
import { bindNativeMessagingIdentityLocked } from './agent-messaging/native-identity.js';
import { wsPublisher } from '../ws/publisher.js';
import { z } from 'zod';
import { idleSessionPoll } from './agent-messaging/idle-session.js';
import { livenessLedger } from './liveness-ledger.js';
import {
  receiverReady,
  receiverState,
  receiverView,
  RECEIVER_FRESH_MS,
  type ReceiverSource,
  type ReceiverState,
  type ReceiverClaimGate,
} from './agent-receiver-state.js';

/** One connection owns reception across both queues; its health never survives a reconnect. */
export class AgentReceiverService {
  private messaging;
  private portal;
  constructor(
    private db: Database,
    private env: Env,
    keyring: Keyring,
  ) {
    this.messaging = createAgentMessagingService(db, env, keyring);
    this.portal = createAgentPortalService(db, env, keyring);
  }

  private async authenticate(id: string, token: string, source?: ReceiverSource) {
    if (source === 'peer' || (source !== 'portal' && (await this.messaging.isEnabled()))) {
      return (await this.messaging.authenticateBridge(id, token)).session;
    }
    return await this.portal.authenticateBridge(id, token);
  }

  /**
   * Messaging transactions serialise on the agent_messaging_enabled row and
   * then lock addresses, hosts and sessions in path-specific orders; the
   * portal bridge locks hosts -> session. Register binds the native identity
   * (which locks the host) and both paths update the address after locking
   * the session, so take the messaging row, the address and the host first
   * or they deadlock against a concurrent send, claim or activity report.
   */
  private async lockAhead(tx: Parameters<Parameters<Database['transaction']>[0]>[0], auth: { hostId: number; agentBusAddressId: string | null }) {
    await tx.select({ name: versions.name }).from(versions).where(eq(versions.name, AGENT_MESSAGING_ENABLED_KEY)).for('update');
    if (auth.agentBusAddressId)
      await tx.select({ id: agentBusAddresses.id }).from(agentBusAddresses).where(eq(agentBusAddresses.id, auth.agentBusAddressId)).for('update');
    await tx.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, auth.hostId)).for('update');
  }

  private changed(id: string) {
    wsPublisher.publish('agent_portal.sessions.changed', { session_id: id });
    wsPublisher.publish('agent_messaging.address.changed', { session_id: id });
  }

  async register(
    id: string,
    token: string,
    input: { generation: string; protocol: ReceiverState['protocol']; native_session_id: string; capabilities?: { delivery_timing_v1?: boolean; queue_delivery_v1?: boolean; peer_batch_v1?: boolean; claim_gate_v1?: boolean } },
  ) {
    const owner=ownerRuntimeFor(this.db);if(owner){const result=await registerOwnedReceiver(owner,this.env,id,token,input);this.changed(id);return result;}
    const auth = await this.authenticate(id, token);
    if ({ codex: 'codex-queue-v1', claude: 'claude-channel-v1', grok: 'grok-acp-v1' }[auth.engine] !== input.protocol)
      throw new ForbiddenError('Receiver engine mismatch', 'receiver_engine_mismatch');
    const sources: ReceiverSource[] = [];
    const activityEnabled = await this.portal.isEnabled();
    if ((await this.messaging.isEnabled()) && auth.agentBusAddressId) sources.push('peer');
    if (activityEnabled && !receiverState(auth.receiver)?.portal_closed)
      sources.push('portal');
    const now = new Date().toISOString();
    const state = await this.db.transaction(async (tx) => {
      await this.lockAhead(tx, auth);
      const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, id)).for('update');
      if (!session || session.endedAt || session.bridgeTokenHash !== auth.bridgeTokenHash)
        throw new ConflictError('Session changed', 'receiver_session_changed');
      const old = receiverState(session.receiver);
      if (old?.generation === input.generation) {
        if (old.protocol !== input.protocol || old.native_session_id !== input.native_session_id)
          throw new ConflictError('Receiver generation was already registered for another native identity', 'receiver_registration_conflict');
        return old;
      }
      if (old && !old.failure && Date.parse(old.heartbeat_at) > Date.now() - RECEIVER_FRESH_MS)
        throw new ConflictError('Another receiver owns this session', 'receiver_owned');
      const next: ReceiverState = {
        ...input,
        portal_closed: old?.portal_closed,
        activity_v1: activityEnabled,
        peer_batch_v1: peerBatchAllowed(this.env, input.capabilities),
        queue_delivery_v1: smartQueueAllowed(this.env, auth.hostId, input.capabilities),
        claim_gate_v1: input.capabilities?.claim_gate_v1 === true,
        delivery_timing_v1: input.capabilities?.delivery_timing_v1 === true,
        heartbeat_at: now,
        failure: null,
        probes: Object.fromEntries(sources.map((source) => [source, {}])),
      };
      await tx
        .update(agentSessions)
        .set({
          receiver: next,
          upstreamSessionId: input.native_session_id,
          adapterProtocol: input.protocol,
          receiveHeartbeatAt: sources.includes('peer') ? now : null,
          relayHeartbeatAt: sources.includes('portal') ? now : null,
          relayEnabled: sources.includes('portal') ? 1 : 0,
        })
        .where(eq(agentSessions.id, id));
      if (session.agentBusAddressId && sources.includes('peer')) {
        const address = await bindNativeMessagingIdentityLocked(tx, session, input.native_session_id, now);
        await tx
          .update(agentBusAddresses)
          .set({
            receiveHeartbeatAt: sources.includes('peer') ? now : null,
            lastUpstreamSessionId: input.native_session_id,
            continuity: 'native',
            adapterProtocol: input.protocol,
          })
          .where(eq(agentBusAddresses.id, address.id));
      }
      return next;
    });
    if (state.probes.peer) await this.messaging.notifyPresenceReturn(id);
    this.changed(id);
    const [bound] = await this.db.select({
      bindingGeneration: agentSessions.bindingGeneration, name: agentSessions.launchName,
      addressName: agentBusAddresses.launchName, addressId: agentBusAddresses.id,
      currentSessionId: agentBusAddresses.currentSessionId, engine: agentSessions.engine,
    }).from(agentSessions).leftJoin(agentBusAddresses, eq(agentBusAddresses.id, agentSessions.agentBusAddressId)).where(eq(agentSessions.id, id));
    const identity = bound?.name && bound.name === bound.addressName && bound.currentSessionId === id ? {
      identity_version: 1, name: bound.name, uuid: bound.addressId, address: `agent:${bound.addressId}`,
      session_id: id, native_session_id: input.native_session_id, engine: bound.engine,
      binding_generation: bound.bindingGeneration,
    } : null;
    return { receiver: receiverView(state), sources: Object.keys(state.probes) as ReceiverSource[],
      capabilities: { activity_v1: state.activity_v1 === true, queue_policy_v1: true, queue_delivery_v1: state.queue_delivery_v1 === true, peer_batch_v1: state.peer_batch_v1 === true, delivery_timing_v1: state.delivery_timing_v1 === true, claim_gate_v1: state.claim_gate_v1 === true }, binding_generation: bound?.bindingGeneration ?? 0, identity };
  }

  async update(
    id: string,
    token: string,
    generation: string,
    operation: 'heartbeat' | 'stop' | 'ack',
    input: { source?: ReceiverSource; nonce?: string; failure?: string; claim_gate?: ReceiverClaimGate },
  ) {
    const owner=ownerRuntimeFor(this.db);if(owner){const result=await updateOwnedReceiver(owner,id,token,generation,operation,input);if(operation!=='heartbeat')this.changed(id);return result;}
    const auth = await this.authenticate(id, token, input.source);
    const peerEnabled = await this.messaging.isEnabled();
    const portalEnabled = await this.portal.isEnabled();
    if (operation === 'heartbeat') {
      const beat = await this.timestampOnlyBeat(auth, generation, input.claim_gate, peerEnabled, portalEnabled);
      if (beat) {
        if (peerEnabled) await this.messaging.notifyPresenceReturn(id);
        return { receiver: beat };
      }
    }
    const result = await this.db.transaction(async (tx) => {
      await this.lockAhead(tx, auth);
      const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, id)).for('update');
      const state = receiverState(session?.receiver);
      if (
        !session ||
        session.endedAt ||
        session.bridgeTokenHash !== auth.bridgeTokenHash ||
        !state ||
        state.generation !== generation
      )
        throw new ConflictError('Receiver generation changed', 'receiver_generation_changed');
      const now = Date.now();
      if (
        operation !== 'stop' &&
        (state.failure || Date.parse(state.heartbeat_at) <= now - RECEIVER_FRESH_MS)
      )
        throw new ConflictError('Receiver connection expired; reconnect', 'receiver_expired');
      if (operation === 'heartbeat') {
        if (input.claim_gate && !state.claim_gate_v1)
          throw new ConflictError('Receiver claim gate telemetry was not negotiated', 'receiver_claim_gate_unsupported');
        state.heartbeat_at = new Date(now).toISOString();
        state.queue_delivery_v1 = smartQueueAllowed(this.env, session.hostId, state);
        if (input.claim_gate) state.claim_gate = { ...input.claim_gate, observed_at: state.heartbeat_at };
        else delete state.claim_gate;
      }
      if (operation === 'stop') {
        state.failure = input.failure ?? 'receiver_stopped';
        if (session.agentBusAddressId && state.probes.peer) await markWaitingForPresence(tx, session.agentBusAddressId);
      }
      if (operation === 'ack') {
        // Compatibility with already-delivered probes from old wrappers. A late
        // receipt is read-only: it cannot renew health or certify model readiness.
        const probe = state.probes[input.source!];
        if (!probe || !input.nonce || probe.nonce !== input.nonce || !probe.delivered_at)
          throw new ConflictError('Probe does not match this delivery', 'receiver_probe_mismatch');
        return receiverView(state);
      }
      // Each source has its own switch. Disabling peer messaging releases its
      // address binding, but must not prevent this session's portal heartbeat
      // or reconnect. Removed sources require a new registration to rejoin.
      if (!peerEnabled) delete state.probes.peer;
      if (!portalEnabled) delete state.probes.portal;
      const peer = receiverReady(state, 'peer', now);
      const portal = receiverReady(state, 'portal', now);
      await tx
        .update(agentSessions)
        .set({
          receiver: state,
          adapterProtocol: state.protocol,
          receiveHeartbeatAt: peer ? state.heartbeat_at : null,
          relayEnabled: portal ? 1 : 0,
          relayHeartbeatAt: portal ? state.heartbeat_at : null,
        })
        .where(eq(agentSessions.id, id));
      if (session.agentBusAddressId && state.probes.peer) {
        const [address] = await tx
          .select()
          .from(agentBusAddresses)
          .where(eq(agentBusAddresses.id, session.agentBusAddressId))
          .for('update');
        if (address?.currentSessionId !== id)
          throw new ConflictError('Address binding changed', 'receiver_binding_changed');
        await tx
          .update(agentBusAddresses)
          .set({ receiveHeartbeatAt: peer ? state.heartbeat_at : null, adapterProtocol: state.protocol })
          .where(eq(agentBusAddresses.id, address.id));
      }
      return receiverView(state);
    });
    if (peerEnabled && operation !== 'stop') await this.messaging.notifyPresenceReturn(id);
    if (operation !== 'heartbeat') this.changed(id);
    return { receiver: result };
  }

  /**
   * A beat from a fresh, unchanged receiver only moves timestamps and claim
   * telemetry. It is answered without the locked transaction and persisted by
   * the liveness ledger. Anything the transaction would change or refuse
   * (generation, failure, expiry, readiness, enabled sources, queue mode,
   * binding) returns null and takes the transactional path, with its errors.
   */
  private async timestampOnlyBeat(
    session: Awaited<ReturnType<AgentReceiverService['authenticate']>>,
    generation: string,
    claimGate: ReceiverClaimGate | undefined,
    peerEnabled: boolean,
    portalEnabled: boolean,
  ) {
    const ledger = livenessLedger(this.db);
    const state = receiverState(session.receiver);
    if (!ledger.active || session.endedAt || !state || state.generation !== generation || state.failure) return null;
    if (claimGate && !state.claim_gate_v1) return null;
    const now = Date.now();
    const held = ledger.receiverHeartbeat(session.id, generation);
    const stored = held && held > state.heartbeat_at ? held : state.heartbeat_at;
    if (!(Date.parse(stored) > now - RECEIVER_FRESH_MS)) return null;
    if (smartQueueAllowed(this.env, session.hostId, state) !== state.queue_delivery_v1) return null;
    if ((!peerEnabled && state.probes.peer) || (!portalEnabled && state.probes.portal)) return null;
    const heartbeatAt = new Date(now).toISOString();
    const next: ReceiverState = { ...state, heartbeat_at: heartbeatAt };
    if (claimGate) next.claim_gate = { ...claimGate, observed_at: heartbeatAt };
    else delete next.claim_gate;
    const peer = receiverReady(next, 'peer', now);
    const portal = receiverReady(next, 'portal', now);
    if (peer !== (session.receiveHeartbeatAt !== null) || portal !== (session.relayEnabled === 1)) return null;
    const bound = Boolean(session.agentBusAddressId && state.probes.peer);
    if (bound) {
      const [address] = await this.db
        .select({ currentSessionId: agentBusAddresses.currentSessionId })
        .from(agentBusAddresses)
        .where(eq(agentBusAddresses.id, session.agentBusAddressId!))
        .limit(1);
      if (address?.currentSessionId !== session.id) return null;
    }
    ledger.noteReceiver(session.id, {
      generation,
      heartbeatAt,
      claimGate: next.claim_gate,
      addressId: bound && peer ? session.agentBusAddressId : null,
    });
    return receiverView(next);
  }

  async status(id: string, token: string) {
    const owner=ownerRuntimeFor(this.db);if(owner)return statusOwnedReceiver(owner,id,token);
    return { receiver: receiverView((await this.authenticate(id, token)).receiver) };
  }

  async claim(id: string, token: string, generation: string, source: ReceiverSource, claimId: string, informationalOnly = false, immediateOnly = false) {
    if(immediateOnly && source !== 'peer') throw new ConflictError('Immediate delivery is only available for peer information', 'delivery_timing_unsupported');
    const owner=ownerRuntimeFor(this.db);if(owner){assertOwnedReceiverClaim(owner,id,token,generation,source);if(source==='peer'){await this.messaging.notifyPresenceReturn(id);return{delivery:await this.messaging.claimForSession(id,token,claimId,generation,informationalOnly || immediateOnly,immediateOnly)};}return{message:await this.portal.claimMessage(id,token,claimId,undefined,generation)};}
    if (z.string().uuid().safeParse(id).success && z.string().uuid().safeParse(claimId).success &&
      await idleSessionPoll(this.db, id, this.env, { bridgeToken: token, receiverGeneration: generation, requireReceiver: true, source })) {
      return source === 'peer' ? { delivery: null } : { message: null };
    }
    const auth = await this.authenticate(id, token, source);
    await this.db.transaction(async (tx) => {
      const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, id)).for('update');
      const state = receiverState(session?.receiver);
      if (
        !session ||
        session.endedAt ||
        session.bridgeTokenHash !== auth.bridgeTokenHash ||
        !state ||
        state.generation !== generation ||
        state.failure ||
        Date.parse(state.heartbeat_at) <= Date.now() - RECEIVER_FRESH_MS
      )
        throw new ConflictError('Receiver is unavailable', 'receiver_expired');
      if (!receiverReady(state, source))
        throw new ForbiddenError('Source is disabled', 'receiver_source_disabled');
    });
    if (source === 'peer') {
      await this.messaging.notifyPresenceReturn(id);
      return { delivery: await this.messaging.claimForSession(id, token, claimId, generation, informationalOnly || immediateOnly, immediateOnly) };
    }
    return { message: await this.portal.claimMessage(id, token, claimId, undefined, generation) };
  }

  async retry(id: string) {
    const owner=ownerRuntimeFor(this.db);if(owner){const result=await retryOwnedReceiver(owner,id);this.changed(id);return result;}
    await this.db.transaction(async (tx) => {
      const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, id)).for('update');
      const state = receiverState(session?.receiver);
      if (!session || session.endedAt || !state)
        throw new ConflictError('No active receiver', 'receiver_missing');
      // Fence delayed claims and heartbeats before the adapter reconnects.
      if (session.agentBusAddressId && state.probes.peer) await markWaitingForPresence(tx, session.agentBusAddressId);
      state.failure = 'reconnect_requested';
      state.generation = randomUUID();
      await tx
        .update(agentSessions)
        .set({ receiver: state, receiveHeartbeatAt: null, relayHeartbeatAt: null, relayEnabled: 0 })
        .where(eq(agentSessions.id, id));
      if (session.agentBusAddressId)
        await tx
          .update(agentBusAddresses)
          .set({ receiveHeartbeatAt: null })
          .where(eq(agentBusAddresses.id, session.agentBusAddressId));
    });
    this.changed(id);
    return { reconnect_requested: true, verification_requested: true };
  }
}

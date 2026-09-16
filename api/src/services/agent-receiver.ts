import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentSessions, agentBusAddresses } from '../db/schema.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { ConflictError, ForbiddenError } from '../http/errors.js';
import { createAgentMessagingService } from './agent-messaging.js';
import { createAgentPortalService } from './agent-portal.js';
import { wsPublisher } from '../ws/publisher.js';
import {
  newReceiverProbe,
  receiverReady,
  receiverState,
  receiverView,
  RECEIVER_FRESH_MS,
  RECEIVER_PROBE_MS,
  type ReceiverSource,
  type ReceiverState,
} from './agent-receiver-state.js';

/** One connection owns reception across both queues; its proof never survives a reconnect. */
export class AgentReceiverService {
  private messaging;
  private portal;
  constructor(
    private db: Database,
    env: Env,
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

  private changed(id: string) {
    wsPublisher.publish('agent_portal.sessions.changed', { session_id: id });
    wsPublisher.publish('agent_messaging.address.changed', { session_id: id });
  }

  async register(
    id: string,
    token: string,
    input: { generation: string; protocol: ReceiverState['protocol']; native_session_id: string },
  ) {
    const auth = await this.authenticate(id, token);
    if ((auth.engine === 'codex') !== (input.protocol === 'codex-queue-v1'))
      throw new ForbiddenError('Receiver engine mismatch', 'receiver_engine_mismatch');
    const sources: ReceiverSource[] = [];
    if ((await this.messaging.isEnabled()) && auth.agentBusAddressId) sources.push('peer');
    if ((await this.portal.isEnabled()) && !receiverState(auth.receiver)?.portal_closed)
      sources.push('portal');
    const now = new Date().toISOString();
    const state = await this.db.transaction(async (tx) => {
      const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, id)).for('update');
      if (!session || session.endedAt || session.bridgeTokenHash !== auth.bridgeTokenHash)
        throw new ConflictError('Session changed', 'receiver_session_changed');
      const old = receiverState(session.receiver);
      if (old?.generation === input.generation) return old;
      if (old && !old.failure && Date.parse(old.heartbeat_at) > Date.now() - RECEIVER_FRESH_MS)
        throw new ConflictError('Another receiver owns this session', 'receiver_owned');
      const next: ReceiverState = {
        ...input,
        portal_closed: old?.portal_closed,
        heartbeat_at: now,
        failure: null,
        probes: Object.fromEntries(sources.map((source) => [source, newReceiverProbe(now)])),
      };
      await tx
        .update(agentSessions)
        .set({
          receiver: next,
          upstreamSessionId: input.native_session_id,
          receiveHeartbeatAt: null,
          relayHeartbeatAt: null,
          relayEnabled: 0,
        })
        .where(eq(agentSessions.id, id));
      if (session.agentBusAddressId) {
        const [address] = await tx
          .select()
          .from(agentBusAddresses)
          .where(eq(agentBusAddresses.id, session.agentBusAddressId))
          .for('update');
        if (address?.currentSessionId !== id)
          throw new ConflictError('Address binding changed', 'receiver_binding_changed');
        await tx
          .update(agentBusAddresses)
          .set({ receiveHeartbeatAt: null, lastUpstreamSessionId: input.native_session_id })
          .where(eq(agentBusAddresses.id, address.id));
      }
      return next;
    });
    this.changed(id);
    return { receiver: receiverView(state), sources };
  }

  async update(
    id: string,
    token: string,
    generation: string,
    operation: 'heartbeat' | 'stop' | 'ack',
    input: { source?: ReceiverSource; nonce?: string; failure?: string },
  ) {
    const auth = await this.authenticate(id, token, input.source);
    const result = await this.db.transaction(async (tx) => {
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
        throw new ConflictError('Receiver connection expired; reconnect and verify', 'receiver_expired');
      if (operation === 'heartbeat') state.heartbeat_at = new Date(now).toISOString();
      if (operation === 'stop') state.failure = input.failure ?? 'receiver_stopped';
      if (operation === 'ack') {
        const probe = state.probes[input.source!];
        if (!probe || probe.nonce !== input.nonce || !probe.delivered_at)
          throw new ConflictError('Probe does not match this delivery', 'receiver_probe_mismatch');
        if (!probe.acknowledged_at) {
          if (now - Date.parse(probe.delivered_at) >= RECEIVER_PROBE_MS)
            throw new ConflictError('Probe expired', 'receiver_probe_expired');
          probe.acknowledged_at = new Date(now).toISOString();
          probe.latency_ms = now - Date.parse(probe.delivered_at);
        }
      }
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
      if (session.agentBusAddressId) {
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
    if (operation !== 'heartbeat') this.changed(id);
    return { receiver: result };
  }

  async status(id: string, token: string) {
    return { receiver: receiverView((await this.authenticate(id, token)).receiver) };
  }

  async claim(id: string, token: string, generation: string, source: ReceiverSource, claimId: string) {
    const auth = await this.authenticate(id, token, source);
    const probe = await this.db.transaction(async (tx) => {
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
      const p = state.probes[source];
      if (!p) throw new ForbiddenError('Source is disabled', 'receiver_source_disabled');
      if (p.acknowledged_at) return null;
      if (p.delivered_at) {
        if (Date.now() - Date.parse(p.delivered_at) >= RECEIVER_PROBE_MS)
          throw new ConflictError('Receiver probe timed out', 'receiver_probe_expired');
        return { probe: { ...p, generation, source } };
      }
      p.delivered_at = new Date().toISOString();
      await tx.update(agentSessions).set({ receiver: state }).where(eq(agentSessions.id, id));
      return { probe: { ...p, generation, source } };
    });
    if (probe) return probe;
    if (source === 'peer')
      return { delivery: await this.messaging.claimForSession(id, token, claimId, generation) };
    return { message: await this.portal.claimMessage(id, token, claimId, undefined, generation) };
  }

  async retry(id: string) {
    await this.db.transaction(async (tx) => {
      const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, id)).for('update');
      const state = receiverState(session?.receiver);
      if (!session || session.endedAt || !state)
        throw new ConflictError('No active receiver', 'receiver_missing');
      // Change the generation so a delayed acknowledgment cannot verify the new connection.
      state.failure = 'verification_requested';
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
    return { verification_requested: true };
  }
}

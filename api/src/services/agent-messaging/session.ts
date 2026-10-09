import { pageAgentAddresses, type AgentDiscoveryFilters } from './discovery.js';
import { assignLaunchNameLocked, endLaunchNamesLocked } from './names.js';
import { receiverView, receiverState } from '../agent-receiver-state.js';
/**
 * Session lifecycle: a managed CLI run registering its bridge, keeping it warm,
 * ending it, and asking who else is reachable.
 *
 * Split out of `../agent-messaging.ts`. Initial address binding lives here;
 * native-identity.ts reconciles later transcript reports from the receiver
 * and heartbeat paths. Host eligibility guards both entry points.
 */

import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import {
  agentBusAddresses,
  agentBusMessages,
  agentBusRelays,
  agentFreshStartGrants,
  agentSessions,
  hosts,
  type AgentBusAddress,
  type AgentSession,
  type Host,
} from '../../db/schema.js';
import type { Env } from '../../env.js';
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from '../../http/errors.js';
import { sha256 } from '../../security/hash.js';
import { type Engine } from '../../util/engine.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import {
  AGENT_PRESENCE_RANK,
  deriveAddressPresence,
  isPresent,
} from '../agent-presence.js';
import { activeHostEngines, assertHostEngineEnabled } from '../host-engine-policy.js';
import { readFleetEngineState } from '../engine-switch.js';
import { messagingHostEligibleSql } from './eligibility.js';
import { hostAuthFingerprint, safeHashEqual } from './internals.js';
import {
  normalizeBridgeToken,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeSessionStatus,
  normalizeUuid,
} from './normalize.js';
import type { AgentMessagingDb, RegisterMessagingSessionInput } from './types.js';
import { publicAddress } from './views.js';
import { bindNativeMessagingIdentityLocked } from './native-identity.js';
import {
  reapExpiredAgentMessagingBindingsLocked,
  suspendAgentMessagingRuntimeLocked,
} from './bindings.js';

/** What the session registry borrows from the bus. */
export interface SessionCore {
  readonly db: Database;
  readonly env: Env;
  isEnabled(): Promise<boolean>;
  requireEnabledLocked(db: AgentMessagingDb): Promise<void>;
  requireAddressLocked(db: AgentMessagingDb, id: string): Promise<AgentBusAddress>;
  resolveAddressLocked(db: AgentMessagingDb, raw: string, forUpdate: boolean): Promise<AgentBusAddress>;
  requireEligibleHostLocked(db: AgentMessagingDb, hostId: number): Promise<Host>;
  requireBridgeSessionLocked(
    db: AgentMessagingDb,
    sessionId: string,
    rawToken: string,
    hostId: number,
  ): Promise<AgentSession>;
  authenticateBridge(
    sessionId: string,
    rawToken: string,
    allowEnded?: boolean,
  ): Promise<{ session: AgentSession; host: Host }>;
  assertSessionRegistration(
    session: AgentSession,
    host: Host,
    engine: Engine,
    username: string,
    cwd: string,
    invocationKind: string,
    bridgeToken: string,
  ): void;
  assertSessionAddressLocked(db: AgentMessagingDb, sessionId: string, address: AgentBusAddress): Promise<void>;
  assertEligibleHost(host: Host): void;
  assertAddressRegistration(
    address: AgentBusAddress,
    host: Host,
    engine: Engine,
    username: string,
    cwd: string,
  ): void;
  assertAddressEligibleLocked(db: AgentMessagingDb, address: AgentBusAddress): Promise<void>;
}

export class SessionRegistry {
  constructor(private readonly core: SessionCore) {}

  /**
   * Revoke runtime eligibility so work cannot sit invisibly in-flight and
   * later replay when eligibility returns. Host status and engine demotions
   * call this. A secure-to-insecure demotion deliberately does not: an
   * insecure host is window-bounded, not disqualified, so its queue is left
   * intact to drain when the window reopens.
   */
  async suspendHostRuntime(
    hostId: number,
    reason: 'host_inactive' | 'engine_disabled',
    engines?: Engine[],
  ): Promise<Record<string, unknown>> {
    const result = await this.core.db.transaction(async (tx) =>
      await suspendAgentMessagingRuntimeLocked(tx, hostId, reason, engines),
    );
    wsPublisher.publish('agent_messaging.host.changed', { host_id: hostId, suspended: true, reason, ...result });
    return { host_id: hostId, suspended: true, reason, ...result };
  }

  async registerSession(host: Host, input: RegisterMessagingSessionInput): Promise<Record<string, unknown>> {
    if (!(await this.core.isEnabled())) return { enabled: false, reason: 'master_disabled' };
    this.core.assertEligibleHost(host);
    const sessionId = normalizeUuid(input.sessionId, 'session_id');
    const bridgeToken = normalizeBridgeToken(input.bridgeToken);
    const username = normalizeRequiredText(input.username, 'username', 255);
    const cwd = normalizeRequiredText(input.cwd, 'cwd', 1024);
    const now = nowIso();
    const bridgeExpiresAt = isoOffsetSeconds(this.core.env.AGENT_PORTAL_BRIDGE_TTL_SECONDS);
    const fingerprint = hostAuthFingerprint(host);
    const result = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const lockedHost = await this.core.requireEligibleHostLocked(tx, host.id);
      if (!safeHashEqual(hostAuthFingerprint(lockedHost), fingerprint)) {
        throw new UnauthorizedError('Host credential changed during registration', 'agent_bridge_host_auth_changed');
      }
      assertHostEngineEnabled(lockedHost, input.engine, await readFleetEngineState(tx));
      // A crashed wrapper may leave its durable address bound until the portal
      // reaper runs. Reclaim expired bindings for this identity in-band so an
      // exact native resume can reclaim its address without guessing by cwd.
      await reapExpiredAgentMessagingBindingsLocked(tx, now, {
        hostId: host.id,
        engine: input.engine,
        username,
      });
      const existingRows = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
      const existing = existingRows[0];
      if (existing) {
        this.core.assertSessionRegistration(existing, host, input.engine, username, cwd, input.invocationKind, bridgeToken);
        if (existing.endedAt) throw new ConflictError('Agent session is finished', 'agent_session_finished');
        await tx.update(agentSessions).set({ hostAuthFingerprint: fingerprint, bridgeExpiresAt, heartbeatAt: now, updatedAt: now }).where(eq(agentSessions.id, sessionId));
      } else {
        await tx.insert(agentSessions).values({
          id: sessionId,
          hostId: host.id,
          engine: input.engine,
          username,
          cwd,
          upstreamSessionId: normalizeOptionalText(input.upstreamSessionId, 255),
          agentBusAddressId: null,
          invocationKind: input.invocationKind,
          status: 'active',
          relayEnabled: 0,
          relayHeartbeatAt: null,
          activeTurnId: null,
          adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
          adapterCapabilities: input.adapterCapabilities ?? null,
          receiveHeartbeatAt: null,
          bindingGeneration: 0,
          hostAuthFingerprint: fingerprint,
          bridgeTokenHash: sha256(bridgeToken),
          bridgeExpiresAt,
          startedAt: now,
          heartbeatAt: now,
          endedAt: null,
          expiresAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      const currentRows = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
      const current = currentRows[0]!;
      let address: AgentBusAddress | null = null;
      let inferredContinuity: 'native' | 'reset' | null = null;
      if (current.agentBusAddressId) {
        const rows = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, current.agentBusAddressId)).limit(1).for('update');
        address = rows[0] ?? null;
        if (!address || address.archivedAt || address.enabled !== 1) {
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
        }
      }
      if (!address && input.requestedAddress) {
        address = await this.core.resolveAddressLocked(tx, input.requestedAddress, true);
        this.core.assertAddressRegistration(address, host, input.engine, username, cwd);
        inferredContinuity = input.upstreamSessionId ? 'native' : 'reset';
        if (
          input.expectedBindingGeneration != null &&
          address.bindingGeneration !== input.expectedBindingGeneration
        ) {
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
        }
      }
      if (!address && input.upstreamSessionId) {
        const rows = await tx
          .select()
          .from(agentBusAddresses)
          .where(and(eq(agentBusAddresses.hostId, host.id), eq(agentBusAddresses.engine, input.engine), eq(agentBusAddresses.username, username), eq(agentBusAddresses.lastUpstreamSessionId, input.upstreamSessionId), eq(agentBusAddresses.enabled, 1), isNull(agentBusAddresses.archivedAt)))
          .orderBy(desc(agentBusAddresses.lastSeenAt))
          .limit(1)
          .for('update');
        if (rows[0]?.currentSessionId && rows[0].currentSessionId !== sessionId) {
          throw new ConflictError('Native transcript is already bound to another lifecycle', 'agent_messaging_address_busy');
        }
        if (rows[0]) {
          address = rows[0];
          inferredContinuity = 'native';
        }
      }
      if (!address) {
        const id = randomUUID();
        address = {
          id,
          address: `agent:${id}`,
          displayAlias: null,
          launchName: null,
          hostId: host.id,
          engine: input.engine,
          username,
          cwd,
          cwdHash: sha256(cwd),
          enabled: 1,
          currentSessionId: sessionId,
          callPin: null,
          callPinExpiresAt: null,
          lastUpstreamSessionId: normalizeOptionalText(input.upstreamSessionId, 255),
          bindingGeneration: 1,
          continuity: input.continuity ?? (input.upstreamSessionId ? 'native' : 'reset'),
          adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
          adapterCapabilities: input.adapterCapabilities ?? null,
          readiness: input.adapterProtocol ? 'ready' : 'resumable',
          receiveHeartbeatAt: input.adapterProtocol ? now : null,
          lastSeenAt: now,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await tx.insert(agentBusAddresses).values(address);
      } else {
        if (address.currentSessionId && address.currentSessionId !== sessionId) {
          throw new ConflictError('Agent address is already bound to another lifecycle', 'agent_messaging_address_busy');
        }
        const nextGeneration = address.currentSessionId === sessionId ? address.bindingGeneration : address.bindingGeneration + 1;
        const nextContinuity = input.continuity ?? (
          address.currentSessionId === sessionId
            ? address.continuity
            : inferredContinuity ?? (input.upstreamSessionId || input.resumed ? 'native' : 'reset')
        );
        const nextUpstream = (address.currentSessionId === sessionId ? current.upstreamSessionId : null) ?? normalizeOptionalText(input.upstreamSessionId, 255) ?? (
          nextContinuity === 'reset' ? null : address.lastUpstreamSessionId
        );
        await tx
          .update(agentBusAddresses)
          .set({
            currentSessionId: sessionId,
            lastUpstreamSessionId: nextUpstream,
            bindingGeneration: nextGeneration,
            continuity: nextContinuity,
            adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
            adapterCapabilities: input.adapterCapabilities ?? null,
            readiness: input.adapterProtocol ? 'ready' : 'resumable',
            receiveHeartbeatAt: input.adapterProtocol ? now : null,
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(agentBusAddresses.id, address.id));
        address = {
          ...address,
          currentSessionId: sessionId,
          lastUpstreamSessionId: nextUpstream,
          bindingGeneration: nextGeneration,
          continuity: nextContinuity,
        };
      }
      if (input.deliveryMessageId && input.deliveryClaimId) {
        const [delivery] = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, input.deliveryMessageId)).limit(1).for('update');
        if (!delivery || !delivery.leaseUntil || delivery.leaseUntil <= now || delivery.targetAddressId !== address.id || delivery.claimId !== input.deliveryClaimId || delivery.status !== 'accepted' || !delivery.leaseOwner?.startsWith('relay:') || delivery.targetBindingGeneration !== input.expectedBindingGeneration) {
          throw new ConflictError('Native delivery no longer owns its target', 'agent_messaging_lease_lost');
        }
        if (delivery.workKind && (!input.upstreamSessionId || input.upstreamSessionId !== delivery.deliveryUpstreamSessionId || input.continuity === 'reset')) {
          const [grant] = await tx.select().from(agentFreshStartGrants).where(eq(agentFreshStartGrants.messageId, delivery.id)).limit(1);
          if (delivery.kind === 'schedule' || !grant || grant.consumedClaimId !== delivery.claimId || grant.targetAddressId !== address.id || grant.executionVersion !== delivery.executionVersion) {
            throw new ConflictError('Native replacement was not authorized for this delivery', 'agent_fresh_start_not_authorized');
          }
        }
        const relayId = delivery.leaseOwner!.split(':')[1]!;
        const [relay] = await tx.select().from(agentBusRelays).where(eq(agentBusRelays.id, relayId)).limit(1).for('update');
        if (!relay || relay.status !== 'active' || relay.generation !== delivery.relayGeneration || relay.hostId !== host.id || relay.username !== username) throw new ConflictError('Relay generation changed', 'agent_messaging_lease_lost');
        await tx.update(agentBusMessages).set({ targetBindingGeneration: address.bindingGeneration, deliverySessionId: sessionId }).where(eq(agentBusMessages.id, delivery.id));
      }
      await tx
        .update(agentSessions)
        .set({
          agentBusAddressId: address.id,
          upstreamSessionId: address.lastUpstreamSessionId,
          adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
          adapterCapabilities: input.adapterCapabilities ?? null,
          receiveHeartbeatAt: input.adapterProtocol ? now : null,
          bindingGeneration: address.bindingGeneration,
          heartbeatAt: now,
          bridgeExpiresAt,
          updatedAt: now,
        })
        .where(eq(agentSessions.id, sessionId));
      const launchName = await assignLaunchNameLocked(tx, sessionId, address.id, now);
      if (!launchName && input.adapterCapabilities?.launch_identity_version === 1)
        throw new ConflictError('No free launch name; retry after a name becomes available', 'agent_name_pool_exhausted');
      await tx.update(agentSessions).set({ launchName }).where(eq(agentSessions.id, sessionId));
      await tx.update(agentBusAddresses).set({ launchName }).where(eq(agentBusAddresses.id, address.id));
      return { address: { ...address, launchName }, bridgeExpiresAt };
    });
    wsPublisher.publish('agent_messaging.address.changed', { address_id: result.address.id, host_id: host.id, engine: input.engine });
    return {
      enabled: true,
      session_id: sessionId,
      bridge_token: bridgeToken,
      expires_at: result.bridgeExpiresAt,
      address: publicAddress(result.address),
      name_status: result.address.launchName ? 'assigned' : 'unavailable',
    };
  }

  async heartbeatSession(
    sessionId: string,
    bridgeToken: string,
    input: {
      status?: string;
      upstreamSessionId?: string | null;
      adapterProtocol?: string | null;
      adapterCapabilities?: Record<string, unknown> | null;
      receiveCapable?: boolean;
      expectedBindingGeneration?: number | null;
      continuity?: 'native' | 'reset';
      /**
       * Return null instead of raising when this session never received a
       * messaging address.
       *
       * The shared liveness heartbeat is sent by *every* managed session,
       * including ones that registered while the fleet switch was off and so
       * were never given an address. For those, messaging simply does not
       * apply, and raising a conflict fails the whole shared heartbeat —
       * taking Agent Portal down with it for the life of the session. An
       * explicit bind keeps raising, because there the caller is asking for a
       * binding it must be told it cannot have.
       */
      skipIfUnbound?: boolean;
    },
  ): Promise<Record<string, unknown> | null> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken);
    const now = nowIso();
    const expiresAt = isoOffsetSeconds(this.core.env.AGENT_PORTAL_BRIDGE_TTL_SECONDS);
    const result = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const session = await this.core.requireBridgeSessionLocked(tx, authenticated.session.id, bridgeToken, authenticated.host.id);
      if (!session.agentBusAddressId) {
        if (input.skipIfUnbound) return null;
        throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
      }
      const addressRows = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, session.agentBusAddressId)).limit(1).for('update');
      let address = addressRows[0];
      if (!address || address.archivedAt || address.enabled !== 1) throw new ForbiddenError('Agent address is disabled', 'agent_messaging_address_disabled');
      if (address.currentSessionId !== session.id) throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
      await this.core.assertAddressEligibleLocked(tx, address);
      if (input.expectedBindingGeneration != null && address.bindingGeneration !== input.expectedBindingGeneration) {
        throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
      }
      if (receiverState(session.receiver) && !receiverState(session.receiver)!.failure && Date.parse(receiverState(session.receiver)!.heartbeat_at) > Date.now()-45_000 && input.receiveCapable !== undefined) {
        throw new ConflictError('Automatic receiver owns this session', 'receiver_owned');
      }
      const receiveHeartbeatAt = input.receiveCapable === undefined
        ? session.receiveHeartbeatAt
        : input.receiveCapable
          ? now
          : null;
      const protocol = normalizeOptionalText(input.adapterProtocol, 32) ?? session.adapterProtocol;
      const upstream = normalizeOptionalText(input.upstreamSessionId, 255) ?? session.upstreamSessionId;
      if (input.upstreamSessionId && upstream) {
        const receiver = receiverState(session.receiver);
        if (receiver && !receiver.failure && receiver.native_session_id !== upstream)
          throw new ConflictError('Automatic receiver owns the native identity', 'receiver_owned');
        address = await bindNativeMessagingIdentityLocked(tx, session, upstream, now);
      }
      const status = normalizeSessionStatus(input.status) ?? session.status;
      await tx
        .update(agentSessions)
        .set({
          status,
          upstreamSessionId: upstream,
          adapterProtocol: protocol,
          adapterCapabilities: input.adapterCapabilities ?? session.adapterCapabilities,
          receiveHeartbeatAt,
          ...(input.receiveCapable !== undefined ? { receiver: null } : {}),
          heartbeatAt: now,
          bridgeExpiresAt: expiresAt,
          updatedAt: now,
        })
        .where(eq(agentSessions.id, session.id));
      await tx
        .update(agentBusAddresses)
        .set({
          lastUpstreamSessionId: upstream ?? address.lastUpstreamSessionId,
          continuity: input.continuity ?? (upstream ? 'native' : address.continuity),
          adapterProtocol: protocol,
          adapterCapabilities: input.adapterCapabilities ?? address.adapterCapabilities,
          readiness: input.receiveCapable === undefined
            ? address.readiness
            : input.receiveCapable
              ? 'live'
              : upstream
                ? 'resumable'
                : 'offline',
          receiveHeartbeatAt,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(agentBusAddresses.id, address.id));
      return { address, status };
    });
    if (!result) return null;
    return {
      enabled: true,
      expires_at: expiresAt,
      status: result.status,
      address: publicAddress(result.address),
    };
  }

  async finishSession(sessionId: string, bridgeToken: string, status: 'completed' | 'failed'): Promise<Record<string, unknown>> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken, true);
    const now = nowIso();
    await this.core.db.transaction(async (tx) => {
      const rows = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
      const session = rows[0];
      if (!session) return;
      await tx
        .update(agentSessions)
        .set({ status, endedAt: session.endedAt ?? now, receiveHeartbeatAt: null, adapterProtocol: null, adapterCapabilities: null, updatedAt: now })
        .where(eq(agentSessions.id, sessionId));
      if (session.agentBusAddressId) {
        await tx
          .update(agentBusAddresses)
          // The PIN dies with the session that opened it: it lives on the
          // address, which outlives the session, so a survivor would leave a
          // later join dialling an address with nobody on it.
          .set({ currentSessionId: null, readiness: session.upstreamSessionId ? 'resumable' : 'offline', receiveHeartbeatAt: null, callPin: null, callPinExpiresAt: null, lastUpstreamSessionId: session.upstreamSessionId, lastSeenAt: now, updatedAt: now })
          .where(and(eq(agentBusAddresses.id, session.agentBusAddressId), eq(agentBusAddresses.currentSessionId, sessionId)));
      }
      await endLaunchNamesLocked(tx, [sessionId], session.endedAt ?? now);
    });
    wsPublisher.publish('agent_messaging.address.changed', { address_id: authenticated.session.agentBusAddressId, status });
    return { enabled: true, status };
  }

  async listAddresses(sessionId: string, bridgeToken: string, filters: AgentDiscoveryFilters = {}): Promise<Record<string, unknown>> {
    const authenticated = await this.core.authenticateBridge(sessionId, bridgeToken);
    const currentAddressId = authenticated.session.agentBusAddressId;
    if (!currentAddressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const predicates = [
      eq(agentBusAddresses.enabled, 1),
      isNull(agentBusAddresses.archivedAt),
      messagingHostEligibleSql(),
      ne(agentBusAddresses.id, currentAddressId),
    ];
    if (filters.engine) predicates.push(eq(agentBusAddresses.engine, filters.engine));
    if (filters.hostId) predicates.push(eq(agentBusAddresses.hostId, filters.hostId));
    const rows = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const current = await this.core.requireAddressLocked(tx, currentAddressId);
      await this.core.assertSessionAddressLocked(tx, authenticated.session.id, current);
      return await tx
        .select({
          address: agentBusAddresses,
          fqdn: hosts.fqdn,
          hostEngines: hosts.engines,
          // Left, not inner: an address whose binding was reaped has no session
          // row to join, and that absence is itself the answer.
          session: { heartbeatAt: agentSessions.heartbeatAt, endedAt: agentSessions.endedAt, receiver: agentSessions.receiver },
        })
        .from(agentBusAddresses)
        .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
        .leftJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
        .where(and(...predicates))
        .orderBy(asc(agentBusAddresses.address));
    });
    const freshAfter = isoOffsetSeconds(-this.core.env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS);
    const fleet = await readFleetEngineState(this.core.db);
    const ranked = rows
      .filter((row) => activeHostEngines(row.hostEngines, fleet).includes(row.address.engine as Engine))
      .map((row) => ({ ...row, receiver: receiverView(row.session?.receiver), presence: deriveAddressPresence(row.address, row.session, freshAfter) }))
      // `online: true` reaches here as `includeOffline: false`. It filters on
      // derived presence, not on `readiness`: that column is a registration
      // latch, so the old blocklist reported a peer as reachable for as long as
      // its row survived — a month, in the worst case observed live.
      .filter((row) => filters.includeOffline !== false || isPresent(row.presence))
      // Reachable first, then most recently seen. The old ordering was
      // alphabetical by address, which is a UUID — so truncating it would have
      // cut at random. Ranking is what makes the cap below safe.
      .sort(
        (a, b) =>
          AGENT_PRESENCE_RANK[a.presence] - AGENT_PRESENCE_RANK[b.presence] ||
          (a.address.lastSeenAt < b.address.lastSeenAt ? 1 : a.address.lastSeenAt > b.address.lastSeenAt ? -1 : 0) ||
          a.address.address.localeCompare(b.address.address),
      );
    const page = pageAgentAddresses(ranked, filters);
    return {
      ...page,
      addresses: page.addresses.map((row) => ({ ...publicAddress(row.address, row.fqdn, row.presence), receiver: row.receiver })),
    };
  }
}

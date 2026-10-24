import { legacyDrainFor } from '../legacy-drain.js';
import { randomUUID } from 'node:crypto';
import {
  agentBusAddresses,
  agentSessions,
  type AgentBusAddress,
  type AgentSession,
  type Host,
} from '../../db/schema.js';
import type { Env } from '../../env.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../http/errors.js';
import { sha256 } from '../../security/hash.js';
import { hostAuthFingerprint, safeHashEqual } from '../../services/agent-messaging/internals.js';
import {
  normalizeBridgeToken,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeUuid,
  jsonRecord,
} from '../../services/agent-messaging/normalize.js';
import { normalizeWorkspace } from '../../services/agent-messaging/workspace.js';
import { publicAddress } from '../../services/agent-messaging/views.js';
import type { RegisterMessagingSessionInput } from '../../services/agent-messaging/types.js';
import { assertHostEngineEnabled } from '../../services/host-engine-policy.js';
import { isTruthyFlagValue } from '../../services/settings.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import type { Json } from '../commands.js';
import { ownedEngineState, ownedMessagingHost, requireOwnedMessaging } from './messaging.js';
import { stageLaunchName, translateOwnedAgent } from './names.js';
import { stageBeginReboot, stageCompleteReboot } from './reboot.js';
import { stageUpdate } from './rows.js';
import { mutateOwnerState, type OwnerMutationContext, type OwnerRuntime } from './runtime.js';
import { assertOwnedHousekeeping } from './session-lifecycle.js';

function resolve(context: OwnerMutationContext, raw: string): AgentBusAddress {
  let value = raw.trim().toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value)) value = `agent:${value}`;
  if (value && !value.startsWith('agent:'))
    value = String(translateOwnedAgent(context.draft.view(), value, nowIso()).address);
  if (!value) throw new ValidationError('to is required', { param: 'to' });
  const address = context.draft
    .table('agentBusAddresses')
    .all()
    .find((row) => row.address === value || row.displayAlias === value);
  if (!address || address.archivedAt || !address.enabled)
    throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
  return address;
}

export async function registerOwnedMessagingSession(
  runtime: OwnerRuntime,
  host: Host,
  input: RegisterMessagingSessionInput,
  env: Env,
): Promise<Record<string, unknown>> {
  runtime.assertOwner();
  if (!isTruthyFlagValue(runtime.state.snapshot().setting('agent_messaging_enabled')))
    return { enabled: false, reason: 'master_disabled' };
  const sessionId = normalizeUuid(input.sessionId, 'session_id'),
    bridgeToken = normalizeBridgeToken(input.bridgeToken);
  const username = normalizeRequiredText(input.username, 'username', 255),
    cwd = normalizeRequiredText(input.cwd, 'cwd', 1024),
    workspace = normalizeWorkspace(input.workspace);
  const fingerprint = hostAuthFingerprint(host);
  const drain = legacyDrainFor(runtime),
    captured = drain?.capturedSession(sessionId);
  if (captured) {
    const snapshot = runtime.state.snapshot(),
      old = snapshot.sessions.get(sessionId),
      address = old?.agentBusAddressId ? snapshot.addresses.get(old.agentBusAddressId) : undefined;
    if (
      !old ||
      !address ||
      old.hostId !== host.id ||
      old.engine !== input.engine ||
      old.username !== username ||
      old.cwd !== cwd ||
      old.invocationKind !== input.invocationKind ||
      (input.upstreamSessionId && input.upstreamSessionId !== old.upstreamSessionId) ||
      address.currentSessionId !== sessionId ||
      address.bindingGeneration !== old.bindingGeneration
    )
      throw new ConflictError('Legacy registration cannot replace a native lifecycle', 'legacy_drain_fenced');
    drain!.recover('session', sessionId, bridgeToken, host.id, username, (current) => {
      requireOwnedMessaging(current);
      const h = ownedMessagingHost(current, host.id);
      if (!safeHashEqual(h.authFingerprint, fingerprint))
        throw new UnauthorizedError('Host credential changed', 'agent_bridge_host_auth_changed');
      assertHostEngineEnabled(h, input.engine, ownedEngineState(current));
    });
    return {
      enabled: true,
      session_id: sessionId,
      bridge_token: bridgeToken,
      expires_at: new Date(drain!.deadline(snapshot, 'session', sessionId)!).toISOString(),
      address: publicAddress(address),
      name_status: old.launchName ? 'assigned' : 'unavailable',
      capabilities: { control_state_protocol: 1 },
      legacy_drain: true,
    };
  }
  const response = await mutateOwnerState(runtime, {
    kind: 'messaging.session.register',
    principal: `host:${host.id}`,
    payload: JSON.parse(
      JSON.stringify({ ...input, bridgeToken: sha256(bridgeToken), sessionId, username, cwd }),
    ) as Json,
    authorize(snapshot) {
      requireOwnedMessaging(snapshot);
      const current = ownedMessagingHost(snapshot, host.id);
      if (!safeHashEqual(current.authFingerprint, fingerprint))
        throw new UnauthorizedError(
          'Host credential changed during registration',
          'agent_bridge_host_auth_changed',
        );
      assertHostEngineEnabled(current, input.engine, ownedEngineState(snapshot));
    },
    prepare(context) {
      const { draft } = context,
        now = nowIso(),
        bridgeExpiresAt = isoOffsetSeconds(env.AGENT_PORTAL_BRIDGE_TTL_SECONDS);
      assertOwnedHousekeeping(context, host.id, input.engine);
      const reboot = stageBeginReboot(context, host.id, input, now);
      const existing = draft.table('agentSessions').get(sessionId);
      let current: AgentSession;
      if (existing) {
        if (
          existing.hostId !== host.id ||
          existing.engine !== input.engine ||
          existing.username !== username ||
          existing.cwd !== cwd ||
          existing.invocationKind !== input.invocationKind ||
          !safeHashEqual(existing.bridgeTokenHash, sha256(bridgeToken))
        )
          throw new ConflictError(
            'Session registration does not match existing lifecycle',
            'agent_session_conflict',
          );
        if (existing.endedAt)
          throw new ConflictError(
            'Agent session is finished; resume in a new managed launch',
            'agent_session_finished',
          );
        current = stageUpdate(context, 'agentSessions', sessionId, {
          ...(input.workspace ? { workspace } : {}),
          hostAuthFingerprint: fingerprint,
          bridgeExpiresAt,
          heartbeatAt: now,
          updatedAt: now,
        });
      } else {
        current = {
          id: sessionId,
          hostId: host.id,
          launchName: null,
          providerAccountId: null,
          engine: input.engine,
          username,
          cwd,
          workspace,
          activity: null,
          upstreamSessionId: normalizeOptionalText(input.upstreamSessionId, 255),
          agentBusAddressId: null,
          invocationKind: input.invocationKind,
          status: 'active',
          relayEnabled: 0,
          relayHeartbeatAt: null,
          activeTurnId: null,
          closeRequestedAt: null,
          adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
          adapterCapabilities: input.adapterCapabilities ?? null,
          receiveHeartbeatAt: null,
          receiver: null,
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
        };
        draft.upsert('agentSessions', current);
        context.write(async (tx) => {
          await tx.insert(agentSessions).values(current);
        });
      }
      let address = current.agentBusAddressId
        ? draft.table('agentBusAddresses').get(current.agentBusAddressId)
        : undefined;
      let inferred: 'native' | 'reset' | undefined;
      if (current.agentBusAddressId && (!address || address.archivedAt || address.enabled !== 1))
        throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
      if (!address && input.requestedAddress) {
        address = resolve(context, input.requestedAddress);
        if (
          address.hostId !== host.id ||
          address.engine !== input.engine ||
          address.username !== username ||
          address.cwd !== cwd
        )
          throw new ForbiddenError(
            'Agent address registration does not match this host/user/directory',
            'agent_messaging_address_mismatch',
          );
        inferred = input.upstreamSessionId ? 'native' : 'reset';
        if (
          input.expectedBindingGeneration != null &&
          address.bindingGeneration !== input.expectedBindingGeneration
        )
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
      }
      if (!address && input.upstreamSessionId) {
        address = draft
          .table('agentBusAddresses')
          .by('hostId', host.id)
          .filter(
            (row) =>
              row.engine === input.engine &&
              row.username === username &&
              row.lastUpstreamSessionId === input.upstreamSessionId &&
              row.enabled === 1 &&
              !row.archivedAt,
          )
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
        if (address?.currentSessionId && address.currentSessionId !== sessionId)
          throw new ConflictError(
            'Native transcript is already bound to another lifecycle',
            'agent_messaging_address_busy',
          );
        if (address) inferred = 'native';
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
          lastUpstreamSessionId: normalizeOptionalText(input.upstreamSessionId, 255),
          bindingGeneration: 1,
          continuity: input.continuity ?? (input.upstreamSessionId ? 'native' : 'reset'),
          adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
          adapterCapabilities: input.adapterCapabilities ?? null,
          readiness: input.adapterProtocol ? 'ready' : 'resumable',
          receiveHeartbeatAt: null,
          lastSeenAt: now,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        const created = address;
        draft.upsert('agentBusAddresses', created);
        context.write(async (tx) => {
          await tx.insert(agentBusAddresses).values(created);
        });
      } else {
        if (address.currentSessionId && address.currentSessionId !== sessionId)
          throw new ConflictError(
            'Agent address is already bound to another lifecycle',
            'agent_messaging_address_busy',
          );
        const continuity =
          input.continuity ??
          (address.currentSessionId === sessionId
            ? address.continuity
            : (inferred ?? (input.upstreamSessionId || input.resumed ? 'native' : 'reset')));
        const upstream =
          (address.currentSessionId === sessionId ? current.upstreamSessionId : null) ??
          normalizeOptionalText(input.upstreamSessionId, 255) ??
          (continuity === 'reset' ? null : address.lastUpstreamSessionId);
        if (address.currentSessionId !== sessionId && continuity === 'reset')
          for (const assignment of draft.table('agentRoleAssignments').by('activeAddressId', address.id))
            stageUpdate(context, 'agentRoleAssignments', assignment.id, {
              status: 'ended',
              activeAddressId: null,
              endedAt: now,
              endReason: 'continuity_reset',
              updatedAt: now,
            });
        address = stageUpdate(context, 'agentBusAddresses', address.id, {
          currentSessionId: sessionId,
          lastUpstreamSessionId: upstream,
          bindingGeneration:
            address.currentSessionId === sessionId
              ? address.bindingGeneration
              : address.bindingGeneration + 1,
          continuity,
          adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
          adapterCapabilities: input.adapterCapabilities ?? null,
          readiness: input.adapterProtocol ? 'ready' : 'resumable',
          receiveHeartbeatAt: null,
          lastSeenAt: now,
          updatedAt: now,
        });
      }
      if (input.deliveryMessageId && input.deliveryClaimId) {
        const delivery = draft.table('agentBusMessages').get(input.deliveryMessageId);
        if (
          !delivery ||
          (delivery.ownershipMode !== 'connection' && (!delivery.leaseUntil || delivery.leaseUntil <= now)) ||
          delivery.targetAddressId !== address.id ||
          delivery.claimId !== input.deliveryClaimId ||
          delivery.status !== 'accepted' ||
          !delivery.leaseOwner?.startsWith('relay:') ||
          delivery.targetBindingGeneration !== input.expectedBindingGeneration
        )
          throw new ConflictError('Native delivery no longer owns its target', 'agent_messaging_lease_lost');
        if (
          delivery.workKind &&
          (!input.upstreamSessionId ||
            input.upstreamSessionId !== delivery.deliveryUpstreamSessionId ||
            input.continuity === 'reset')
        ) {
          const grant = draft.table('agentFreshStartGrants').get(delivery.id);
          if (
            delivery.kind === 'schedule' ||
            !grant ||
            grant.consumedClaimId !== delivery.claimId ||
            grant.targetAddressId !== address.id ||
            grant.executionVersion !== delivery.executionVersion
          )
            throw new ConflictError(
              'Native replacement was not authorized for this delivery',
              'agent_fresh_start_not_authorized',
            );
        }
        const relay = draft.table('agentBusRelays').get(delivery.leaseOwner.split(':')[1]!);
        const relayUsername =
          jsonRecord(relay?.capabilities)?.host_daemon === true ? `${username}:daemon` : username;
        if (
          !relay ||
          relay.status !== 'active' ||
          relay.generation !== delivery.relayGeneration ||
          relay.hostId !== host.id ||
          relay.username !== relayUsername ||
          (delivery.ownerInstanceId && delivery.ownerInstanceId !== relay.instanceId)
        )
          throw new ConflictError('Relay generation changed', 'agent_messaging_lease_lost');
        stageUpdate(context, 'agentBusMessages', delivery.id, {
          targetBindingGeneration: address.bindingGeneration,
          deliverySessionId: sessionId,
        });
      }
      stageUpdate(context, 'agentSessions', sessionId, {
        agentBusAddressId: address.id,
        upstreamSessionId: address.lastUpstreamSessionId,
        adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
        adapterCapabilities: input.adapterCapabilities ?? null,
        receiveHeartbeatAt: null,
        bindingGeneration: address.bindingGeneration,
        heartbeatAt: now,
        bridgeExpiresAt,
        updatedAt: now,
      });
      stageCompleteReboot(context, reboot, sessionId, address, now);
      const launchName = stageLaunchName(context, sessionId, address.id, now);
      if (!launchName && input.adapterCapabilities?.launch_identity_version === 1)
        throw new ConflictError(
          'No free launch name; retry after a name becomes available',
          'agent_name_pool_exhausted',
        );
      stageUpdate(context, 'agentSessions', sessionId, { launchName });
      address = stageUpdate(context, 'agentBusAddresses', address.id, { launchName });
      return JSON.parse(
        JSON.stringify({
          enabled: true,
          session_id: sessionId,
          bridge_token: bridgeToken,
          expires_at: bridgeExpiresAt,
          address: publicAddress(address),
          name_status: launchName ? 'assigned' : 'unavailable',
          capabilities: { control_state_protocol: 1 },
        }),
      ) as Json;
    },
  });
  wsPublisher.publish('agent_messaging.address.changed', {
    session_id: sessionId,
    host_id: host.id,
    engine: input.engine,
  });
  return response as Record<string, unknown>;
}

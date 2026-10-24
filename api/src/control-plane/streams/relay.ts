import { legacyDrainFor } from '../legacy-drain.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { agentBusRelays, type Host } from '../../db/schema.js';
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  ServiceUnavailableError,
} from '../../http/errors.js';
import { sha256 } from '../../security/hash.js';
import { hostAuthFingerprint, safeHashEqual } from '../../services/agent-messaging/internals.js';
import {
  normalizeRequiredText,
  normalizeUuid,
  jsonRecord,
} from '../../services/agent-messaging/normalize.js';
import { daemonAccepting, daemonResidentFor } from '../../services/host-daemon/policy.js';
import { activeHostEngines } from '../../services/host-engine-policy.js';
import { AGENT_MESSAGING_RELAY_TOKEN_SECONDS } from '../../services/agent-messaging/constants.js';
import { wsPublisher } from '../../ws/publisher.js';
import { type OwnerRuntime, mutateOwnerState, setOwnerRequestPrincipal } from '../state/runtime.js';
import type { OwnerStateSnapshot } from '../state/store.js';
import {
  ownedRelay,
  ownedMessagingHost,
  requireOwnedMessaging,
  ownedEngineState,
} from '../state/messaging.js';
import { ownerPresence } from '../presence.js';
import { stageUpdate } from '../state/rows.js';
import { ownedCredentialDeadline } from '../credentials.js';
import type { Engine } from '../../util/engine.js';

function gate(
  snapshot: OwnerStateSnapshot,
  hostId: number,
  username: string,
  capabilities: unknown,
  draining = false,
) {
  const daemon = snapshot.daemons.get(hostId),
    isDaemon = jsonRecord(capabilities)?.host_daemon === true;
  if (isDaemon) {
    if (daemon && daemonAccepting(daemon.settings) && username === daemon.settings.username + ':daemon')
      return;
    if (
      draining &&
      snapshot
        .table('hostDaemonSessions')
        .by('hostId', hostId)
        .some(
          (s) =>
            ['running', 'stopping'].includes(s.status) ||
            (s.addressId &&
              snapshot.messages
                .by('targetAddressId', s.addressId)
                .some((m) => ['leased', 'accepted'].includes(m.status))),
        )
    )
      return;
    throw new ForbiddenError('Daemon relay is not enabled');
  }
  if (!daemon || !daemonResidentFor(daemon.settings, username))
    throw new ServiceUnavailableError('Persistent relay is not enabled', 'agent_messaging_not_persistent');
}
function held(snapshot: OwnerStateSnapshot, id: string, generation: number) {
  return snapshot.messages
    .all()
    .some(
      (m) =>
        m.leaseOwner === `relay:${id}:${generation}` &&
        ['leased', 'accepted', 'reboot_hold'].includes(m.status),
    );
}
export async function registerOwnedRelay(
  owner: OwnerRuntime,
  admitted: Host,
  input: {
    username: string;
    instanceId: string;
    wrapperVersion: string;
    capabilities?: Record<string, unknown> | null;
  },
) {
  const username = normalizeRequiredText(input.username, 'username', 255),
    instanceId = normalizeUuid(input.instanceId, 'instance_id'),
    wrapperVersion = normalizeRequiredText(input.wrapperVersion, 'wrapper_version', 64);
  const token = randomBytes(32).toString('base64url'),
    fingerprint = hostAuthFingerprint(admitted);
  let changedId = '';
  const result = await mutateOwnerState(owner, {
    kind: 'messaging.relay.register',
    payload: { hostId: admitted.id, username, instanceId, wrapperVersion },
    prepare(context) {
      const s = context.snapshot;
      requireOwnedMessaging(s);
      const host = ownedMessagingHost(s, admitted.id);
      if (!safeHashEqual(host.authFingerprint, fingerprint))
        throw new UnauthorizedError(
          'Host credential changed during relay registration',
          'agent_messaging_relay_host_auth_changed',
        );
      gate(s, host.id, username, input.capabilities);
      const existing = s
        .table('agentBusRelays')
        .by('hostId', host.id)
        .find((r) => r.username === username);
      if (existing && ownerPresence(owner).hasRelay(existing.id))
        throw new ConflictError('Relay instance still connected', 'agent_messaging_relay_attached');
      if (existing && existing.instanceId !== instanceId && held(s, existing.id, existing.generation))
        throw new ConflictError(
          'Previous relay work has an unresolved outcome',
          'agent_messaging_relay_uncertain',
        );
      const now = new Date().toISOString(),
        expiresAt = new Date(Date.now() + AGENT_MESSAGING_RELAY_TOKEN_SECONDS * 1000).toISOString();
      const generation = existing
        ? existing.instanceId === instanceId && existing.status === 'active'
          ? existing.generation
          : existing.generation + 1
        : 1;
      const next = {
        id: existing?.id ?? randomUUID(),
        hostId: host.id,
        username,
        instanceId,
        generation,
        tokenHash: sha256(token),
        tokenExpiresAt: expiresAt,
        hostAuthFingerprint: fingerprint,
        wrapperVersion,
        capabilities: input.capabilities ?? null,
        status: 'active',
        heartbeatAt: now,
        stopRequestedAt: null,
        stoppedAt: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) stageUpdate(context, 'agentBusRelays', existing.id, next);
      else {
        context.draft.upsert('agentBusRelays', next);
        context.write((tx) => tx.insert(agentBusRelays).values(next));
      }
      changedId = next.id;
      return {
        enabled: true,
        relay_id: next.id,
        generation,
        relay_token: token,
        expires_at: expiresAt,
        poll_seconds: 25,
      };
    },
  });
  wsPublisher.publish('agent_messaging.relay.changed', {
    relay_id: changedId,
    host_id: admitted.id,
    status: 'active',
  });
  return result as Record<string, unknown>;
}
export function heartbeatOwnedRelay(owner: OwnerRuntime, id: string, token: string) {
  owner.assertOwner();
  legacyDrainFor(owner)?.renew('relay', id, token);
  const s = owner.state.snapshot(),
    { relay } = ownedRelay(s, id, token);
  gate(s, relay.hostId, relay.username, relay.capabilities, true);
  return {
    enabled: true,
    generation: relay.generation,
    expires_at: new Date(ownedCredentialDeadline(s, 'relay', id)).toISOString(),
    stop_requested: Boolean(relay.stopRequestedAt),
  };
}
export async function stopOwnedRelay(owner: OwnerRuntime, id: string, token: string) {
  const snapshot = owner.state.snapshot(),
    { relay } = ownedRelay(snapshot, id, token);
  if (held(snapshot, id, relay.generation)) return { stopped: false, draining: true };
  return mutateOwnerState(owner, {
    kind: 'messaging.relay.stop',
    payload: { id },
    authorize: (s) => {
      ownedRelay(s, id, token);
    },
    prepare(context) {
      const current = ownedRelay(context.snapshot, id, token).relay;
      if (held(context.snapshot, id, current.generation)) return { stopped: false, draining: true };
      const now = new Date().toISOString();
      stageUpdate(context, 'agentBusRelays', id, {
        status: 'stopped',
        tokenHash: null,
        tokenExpiresAt: null,
        stoppedAt: now,
        updatedAt: now,
      });
      return { stopped: true, draining: false };
    },
  }) as Promise<Record<string, unknown>>;
}
export function pendingOwnedRelayWork(
  snapshot: OwnerStateSnapshot,
  ids: readonly string[],
  now = Date.now(),
): boolean {
  return ids.some((id) => {
    const messages = snapshot.messages.by('targetAddressId', id);
    return messages.some((m) => {
      if (m.status === 'leased') return true;
      if (m.status === 'batched' && m.digestId) {
        const root = snapshot.messages.get(m.digestId);
        if (
          root &&
          root.targetAddressId === id &&
          root.kind === 'digest' &&
          ['queued', 'expired', 'dead', 'canceled'].includes(root.status) &&
          !root.acceptedAt &&
          !root.presentedAt &&
          !root.ambiguousAt
        )
          return true;
      }
      if (m.kind === 'presence_notice' && ['accepted', 'batched'].includes(m.status)) return true;
      if (m.status !== 'queued') return false;
      if (Date.parse(m.expiresAt) <= now || ['presence_notice', 'publication', 'digest'].includes(m.kind))
        return true;
      if (Date.parse(m.nextAttemptAt) > now) return false;
      return !messages.some(
        (other) =>
          other.id !== m.id &&
          (['leased', 'accepted', 'reboot_hold'].includes(other.status) ||
            (other.status === 'queued' && other.dispatchOrder < m.dispatchOrder)),
      );
    });
  });
}
export function ownedRelayTargets(owner: OwnerRuntime, id: string, token: string) {
  owner.assertOwner();
  const s = owner.state.snapshot(),
    { relay, host } = ownedRelay(s, id, token);
  gate(s, host.id, relay.username, relay.capabilities, true);
  setOwnerRequestPrincipal({
    principal: `relay:${id}:${relay.generation}`,
    revalidate(snapshot) {
      const current = ownedRelay(snapshot, id, token).relay;
      if (
        current.instanceId !== relay.instanceId ||
        current.generation !== relay.generation ||
        !ownerPresence(owner)
          .all()
          .some(
            (a) =>
              a.scope.topic === 'relay' &&
              a.scope.relay_id === id &&
              a.scope.native_instance_id === current.instanceId &&
              a.scope.binding_generation === current.generation,
          )
      )
        throw new ConflictError('Relay instance changed', 'agent_messaging_relay_detached');
      gate(snapshot, current.hostId, current.username, current.capabilities, true);
    },
  });
  if (
    !ownerPresence(owner)
      .all()
      .some(
        (a) =>
          a.scope.topic === 'relay' &&
          a.scope.relay_id === id &&
          a.scope.native_instance_id === relay.instanceId &&
          a.scope.binding_generation === relay.generation,
      )
  )
    throw new ConflictError('Relay attachment unavailable', 'agent_messaging_relay_detached');
  const daemon = jsonRecord(relay.capabilities)?.host_daemon === true,
    username = daemon ? relay.username.replace(/:daemon$/, '') : relay.username;
  const remote = s.table('hostDaemonSessions').by('hostId', host.id),
    engines = activeHostEngines(host.engines, ownedEngineState(s));
  const ids = s.addresses
    .by('hostId', host.id)
    .filter(
      (a) =>
        a.username === username &&
        a.enabled === 1 &&
        !a.archivedAt &&
        !a.currentSessionId &&
        engines.includes(a.engine as Engine) &&
        (daemon
          ? remote.some((r) => r.addressId === a.id && ['idle', 'waiting'].includes(r.status))
          : !remote.some((r) => r.addressId === a.id)),
    )
    .map((a) => a.id);
  return ids.length && pendingOwnedRelayWork(s, ids) ? { relay, ids } : null;
}

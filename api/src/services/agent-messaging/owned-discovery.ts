import type { Database } from '../../db/client.js';
import type { Host } from '../../db/schema.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';
import type { OwnerRuntime } from '../../control-plane/state/runtime.js';
import {
  ownedAddress,
  ownedBridge,
  ownedEngineState,
  ownedMessagingHost,
} from '../../control-plane/state/messaging.js';
import { ownedAddressPresence } from '../../control-plane/state/presence-notices.js';
import { ownedReceiverView } from '../../control-plane/streams/receiver.js';
import { translateOwnedAgent } from '../../control-plane/state/names.js';
import { activeHostEngines } from '../host-engine-policy.js';
import { isPresent, AGENT_PRESENCE_RANK } from '../agent-presence.js';
import { activeRolesForAddresses, roleLabelsForAddress, addressesHoldingRole } from '../roles/assignments.js';
import { isTruthyFlagValue } from '../settings.js';
import { nowIso } from '../../util/timestamp.js';
import type { Engine } from '../../util/engine.js';
import { pageAgentAddresses, type AgentDiscoveryFilters } from './discovery.js';
import { workspaceMatch, workspaceCoverage, readWorkspace } from './workspace.js';
import { publicAddress } from './views.js';
import { LIVE_MESSAGE_STATUSES } from './constants.js';
import type { HostInventoryFilters } from './host-inventory.js';

export async function ownedSelf(
  db: Database,
  runtime: OwnerRuntime,
  id: string,
  token: string,
): Promise<Record<string, unknown>> {
  runtime.assertOwner();
  const snapshot = runtime.state.snapshot(),
    session = ownedBridge(snapshot, id, token).session;
  if (!session.agentBusAddressId)
    throw new ConflictError('Launch identity unavailable', 'agent_identity_unavailable');
  const address = ownedAddress(snapshot, session.agentBusAddressId);
  if (
    address.currentSessionId !== id ||
    address.bindingGeneration !== session.bindingGeneration ||
    !session.launchName ||
    address.launchName !== session.launchName
  )
    throw new ConflictError('Launch identity binding changed', 'agent_identity_unavailable');
  const identity = translateOwnedAgent(snapshot, session.launchName, nowIso());
  if (identity.uuid !== address.id || identity.session_id !== id || identity.status !== 'active')
    throw new ConflictError('Launch name lease changed', 'agent_identity_unavailable');
  const previous = snapshot
    .table('agentNameLeases')
    .all()
    .filter((row) => row.addressId === address.id || row.sessionId === id);
  const roles = await activeRolesForAddresses(db, [address.id], snapshot),
    labels = await roleLabelsForAddress(db, address.id, snapshot);
  ownedBridge(runtime.state.snapshot(), id, token, { generation: session.bindingGeneration });
  return {
    identity_version: 1,
    name: session.launchName,
    uuid: address.id,
    address: address.address,
    session_id: id,
    native_session_id: session.upstreamSessionId,
    engine: session.engine,
    binding_generation: session.bindingGeneration,
    previous_names: [...new Set(previous.map((row) => row.name))],
    task_title: session.taskTitleNativeId === session.upstreamSessionId ? session.taskTitle : null,
    role: roles.get(address.id) ?? null,
    role_labels: labels,
  };
}
export async function discoverOwnedAddresses(
  db: Database,
  runtime: OwnerRuntime,
  id: string,
  token: string,
  filters: AgentDiscoveryFilters,
): Promise<Record<string, unknown>> {
  runtime.assertOwner();
  const snapshot = runtime.state.snapshot(),
    me = ownedBridge(snapshot, id, token).session,
    scope = filters.scope ?? 'fleet';
  if (!me.agentBusAddressId)
    throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
  const self = ownedAddress(snapshot, me.agentBusAddressId);
  if (self.currentSessionId !== id || self.bindingGeneration !== me.bindingGeneration)
    throw new ConflictError('Address binding changed', 'agent_messaging_binding_stale');
  const holders = filters.role ? new Set(await addressesHoldingRole(db, filters.role, snapshot)) : undefined;
  const eligible = snapshot.addresses.all().flatMap((address) => {
    if (
      address.id === self.id ||
      (filters.engine && address.engine !== filters.engine) ||
      (filters.hostId && address.hostId !== filters.hostId) ||
      (holders && !holders.has(address.id)) ||
      snapshot.hosts.get(address.hostId)?.internalRole
    )
      return [];
    try {
      ownedAddress(snapshot, address.id);
    } catch {
      return [];
    }
    const session = address.currentSessionId ? snapshot.sessions.get(address.currentSessionId) : undefined,
      presence = ownedAddressPresence(runtime, snapshot, address);
    if (filters.includeOffline === false && !isPresent(presence)) return [];
    return [
      {
        address,
        session,
        presence,
        fqdn: snapshot.hosts.get(address.hostId)!.fqdn,
        receiver: session ? ownedReceiverView(runtime, session) : null,
      },
    ];
  });
  const projectPeers = new Set<string>();
  if (scope === 'project' && snapshot.setting('agent_coordination_enabled') === '1') {
    const members = snapshot
        .table('agentScopeMembers')
        .all()
        .filter(
          (m) => m.state === 'active' && snapshot.table('agentScopes').get(m.scopeId)?.kind === 'project',
        ),
      own = members.find((m) => m.sessionId === id);
    if (own)
      for (const member of members) if (member.scopeId === own.scopeId) projectPeers.add(member.sessionId);
  }
  const ranked = eligible
    .map((row) => ({
      ...row,
      match:
        scope === 'project' && projectPeers.has(row.session?.id ?? '')
          ? 'same_project'
          : workspaceMatch(
              me,
              {
                hostId: row.address.hostId,
                cwd: row.session?.cwd ?? row.address.cwd,
                workspace: row.session?.workspace,
              },
              scope,
            ),
    }))
    .filter((row) => row.match !== null)
    .sort(
      (a, b) =>
        AGENT_PRESENCE_RANK[a.presence] - AGENT_PRESENCE_RANK[b.presence] ||
        b.address.lastSeenAt.localeCompare(a.address.lastSeenAt) ||
        a.address.address.localeCompare(b.address.address),
    );
  const page = pageAgentAddresses(ranked, filters),
    roles = await activeRolesForAddresses(
      db,
      page.addresses.map((row) => row.address.id),
      snapshot,
    );
  ownedBridge(runtime.state.snapshot(), id, token, { generation: me.bindingGeneration });
  return {
    ...page,
    scope,
    observed_at: nowIso(),
    ...workspaceCoverage(
      me,
      eligible.map((row) => ({
        hostId: row.address.hostId,
        cwd: row.session?.cwd ?? row.address.cwd,
        workspace: row.session?.workspace,
      })),
      scope,
    ),
    addresses: page.addresses.map((row) => ({
      ...publicAddress(row.address, row.fqdn, row.presence),
      presence_source: 'connection',
      receiver: row.receiver,
      cwd: readWorkspace(row.session?.workspace)?.cwd ?? row.session?.cwd ?? row.address.cwd,
      task_title:
        row.session?.taskTitleNativeId === row.session?.upstreamSessionId
          ? (row.session?.taskTitle ?? null)
          : null,
      role: roles.get(row.address.id) ?? null,
      match_reason: row.match,
    })),
  };
}
export function ownedHostInventory(runtime: OwnerRuntime, host: Host, filters: HostInventoryFilters = {}) {
  runtime.assertOwner();
  const snapshot = runtime.state.snapshot(),
    current = snapshot.hosts.get(host.id);
  if (!current) throw new NotFoundError('Host not found', 'host_not_found');
  const enabled = isTruthyFlagValue(snapshot.setting('agent_messaging_enabled'), false),
    active = activeHostEngines(current.engines, ownedEngineState(snapshot));
  const addresses = snapshot.addresses
    .by('hostId', host.id)
    .filter((address) => !address.archivedAt && (!filters.engine || address.engine === filters.engine))
    .sort((a, b) => a.address.localeCompare(b.address))
    .flatMap((address) => {
      const session = address.currentSessionId ? snapshot.sessions.get(address.currentSessionId) : undefined,
        presence = ownedAddressPresence(runtime, snapshot, address);
      if (filters.includeOffline === false && !isPresent(presence)) return [];
      const counts: Record<string, number> = {};
      for (const message of snapshot.messages.by('targetAddressId', address.id))
        if (LIVE_MESSAGE_STATUSES.includes(message.status as (typeof LIVE_MESSAGE_STATUSES)[number]))
          counts[message.status] = (counts[message.status] ?? 0) + 1;
      return [
        {
          ...publicAddress(address, current.fqdn, presence),
          presence_source: 'connection',
          cwd: session?.cwd ?? address.cwd,
          receiver: session ? ownedReceiverView(runtime, session) : null,
          current_session_id: address.currentSessionId,
          upstream_session_id: session?.upstreamSessionId ?? null,
          last_upstream_session_id: address.lastUpstreamSessionId,
          engine_active: active.includes(address.engine as Engine),
          queue_depth: Object.values(counts).reduce((sum, n) => sum + n, 0),
          accepted_work: counts.accepted ?? 0,
          queue: counts,
        },
      ];
    });
  return {
    scope: 'host',
    read_only: true,
    enabled,
    host_id: host.id,
    fqdn: current.fqdn,
    observed_at: nowIso(),
    total: addresses.length,
    addresses,
  };
}

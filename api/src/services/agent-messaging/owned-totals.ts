import { requireOwnerRuntime } from '../../control-plane/state/runtime.js';
import { ownedEngineState, ownedMessagingHost } from '../../control-plane/state/messaging.js';
import { ownedAddressPresence } from '../../control-plane/state/presence-notices.js';
import { ownedCredentialDeadline } from '../../control-plane/credentials.js';
import type { Database } from '../../db/client.js';
import { ENGINES, type Engine } from '../../util/engine.js';
import { activeHostEngines } from '../host-engine-policy.js';
import { isTruthyFlagValue } from '../settings.js';
import { AGENT_MESSAGING_ENABLED_KEY, LIVE_MESSAGE_STATUSES } from './constants.js';
/** Historical totals describe every retained database row; live eligibility is connection-owned. */
export function ownedMessagingTotalsView(db: Database): Record<string, unknown> {
  const runtime = requireOwnerRuntime(db),
    snapshot = runtime.state.snapshot(),
    enabled = isTruthyFlagValue(snapshot.setting(AGENT_MESSAGING_ENABLED_KEY)),
    fleet = ownedEngineState(snapshot),
    totals = snapshot.messagingTotals,
    now = Date.now();
  const eligibleHost = (id: number) => {
    const host = snapshot.hosts.get(id);
    if (!host || host.internalRole) return false;
    try {
      ownedMessagingHost(snapshot, id, now);
      return true;
    } catch {
      return false;
    }
  };
  const addresses = enabled
    ? snapshot.addresses
        .all()
        .filter(
          (row) =>
            row.enabled === 1 &&
            !row.archivedAt &&
            eligibleHost(row.hostId) &&
            activeHostEngines(snapshot.hosts.get(row.hostId)!.engines, fleet).includes(row.engine as Engine),
        )
    : [];
  const relays = enabled
    ? snapshot
        .table('agentBusRelays')
        .all()
        .filter(
          (row) =>
            row.status === 'active' &&
            eligibleHost(row.hostId) &&
            ownedCredentialDeadline(snapshot, 'relay', row.id) > now,
        )
    : [];
  const bus = (source: string, target: string, statuses?: readonly string[]) =>
    totals.bus
      .filter(
        (row) =>
          row.sourceEngine === source &&
          row.targetEngine === target &&
          (!statuses || statuses.includes(row.status)),
      )
      .reduce((sum, row) => sum + row.count, 0);
  const portal = (engine: string, statuses?: readonly string[]) =>
    totals.portal
      .filter((row) => row.engine === engine && (!statuses || statuses.includes(row.status)))
      .reduce((sum, row) => sum + row.count, 0);
  const count = (status: string) =>
    totals.bus.filter((row) => row.status === status).reduce((sum, row) => sum + row.count, 0);
  const directions = ENGINES.flatMap((source) =>
    ENGINES.map((target) => ({
      source_engine: source,
      target_engine: target,
      total: bus(source, target),
      pending: bus(source, target, LIVE_MESSAGE_STATUSES),
      completed: bus(source, target, ['completed']),
      dead: bus(source, target, ['dead']),
      ambiguous: bus(source, target, ['ambiguous']),
    })),
  );
  const serverDirections = ENGINES.flatMap((engine) => {
    const responses = totals.responses.find((row) => row.engine === engine)?.count ?? 0;
    return [
      {
        source_engine: 'server',
        target_engine: engine,
        total: portal(engine) + bus('server', engine),
        pending: portal(engine, ['queued', 'leased']) + bus('server', engine, LIVE_MESSAGE_STATUSES),
        completed: portal(engine, ['accepted']) + bus('server', engine, ['completed']),
        dead: portal(engine, ['dead']) + bus('server', engine, ['dead']),
        ambiguous: bus('server', engine, ['ambiguous']),
      },
      {
        source_engine: engine,
        target_engine: 'server',
        total: responses,
        pending: 0,
        completed: responses,
        dead: 0,
        ambiguous: 0,
      },
    ];
  });
  return {
    enabled,
    initial_default: false,
    presence_source: 'connection',
    addresses: addresses.length,
    live_addresses: addresses.filter((row) => ownedAddressPresence(runtime, snapshot, row) === 'listening')
      .length,
    relays: relays.length,
    open_conversations: snapshot.table('agentBusConversations').by('status', 'open').length,
    messages: {
      queued: count('queued'),
      leased: count('leased'),
      accepted: count('accepted'),
      dead: count('dead'),
      ambiguous: count('ambiguous'),
    },
    directions,
    server_directions: serverDirections,
    delivery: 'ordered_at_least_once',
  };
}

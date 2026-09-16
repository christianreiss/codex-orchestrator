/**
 * Who may use the bus: host eligibility, its SQL twin, and participation checks.
 *
 * Part of the `agent-messaging` module; the public interface is the
 * `AgentMessagingService` facade in `../agent-messaging.ts`.
 */

import { and, eq, gt, or } from 'drizzle-orm';

import { hosts, type AgentBusConversation, type Host } from '../../db/schema.js';
import { type Engine } from '../../util/engine.js';
import { insecureWindowActive } from '../insecure-window.js';

/**
 * The single host-eligibility rule for Agent Messaging. The fleet switch is
 * the only switch: once it is on the bus is on for every host, including
 * insecure ones. An insecure host is authorized per operation for as long as
 * its allowed window is open, which is read, never extended — see
 * `insecureWindowActive`. Status and engine remain gates because an inactive
 * host or a removed engine has no agent to address.
 */
export function messagingHostEligible(
  host: Pick<Host, 'status' | 'secure' | 'insecureEnabledUntil'>,
): boolean {
  return host.status === 'active' && (host.secure === 1 || insecureWindowActive(host));
}

/**
 * The SQL half of `messagingHostEligible`, for queries that select candidate
 * hosts instead of checking one row. `gt` is given a `Date` on purpose:
 * drizzle's `datetime` column maps it through `toISOString()`, matching how
 * the window was stored. Passing an ISO string here would compare the `T`/`Z`
 * form against a MySQL DATETIME and silently return the wrong host set.
 *
 * Exported so the fleet-window suite can assert against the real predicate:
 * being SQL, it cannot consult the fleet-window settings key and is only right
 * if the deadline stamped on the host row is right, which is precisely what a
 * DB-less fake cannot check.
 */
export function messagingHostEligibleSql(now: Date = new Date()) {
  return and(
    eq(hosts.status, 'active'),
    or(eq(hosts.secure, 1), gt(hosts.insecureEnabledUntil, now)),
  );
}

export function addressIneligibleReason(
  masterEnabled: boolean,
  eligible: boolean,
  secure: boolean,
  hostStatus: string,
  engines: Engine[],
  engine: Engine,
): string | null {
  if (!masterEnabled) return 'master_disabled';
  if (hostStatus !== 'active') return 'host_inactive';
  if (!secure && !eligible) return 'insecure_window_closed';
  if (!engines.includes(engine)) return 'engine_disabled';
  return null;
}

export function conversationIncludes(conversation: AgentBusConversation, addressId: string): boolean {
  return conversation.addressAId === addressId || conversation.addressBId === addressId;
}

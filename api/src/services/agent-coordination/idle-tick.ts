import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  agentSessions,
  agentEvents,
  hosts,
  agentScopeMembers,
  agentScopeBindings,
  agentScopes,
  agentResourceClaims,
  agentScopeEvents,
  versions,
} from '../../db/schema.js';
import type { Env } from '../../env.js';
import { sha256 } from '../../security/hash.js';
import { isFreshPresenceTimestamp } from '../agent-presence.js';
import { isTruthyFlagValue } from '../settings.js';
import { ENGINES } from '../../util/engine.js';
import { ENGINE_DISABLED_FLAGS, type FleetEngineState } from '../engine-switch.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function rows(value: unknown): Record<string, unknown>[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed == null) return [];
  if (!Array.isArray(parsed) || parsed.some((row) => !row || typeof row !== 'object' || Array.isArray(row)))
    throw new Error('Invalid coordination input snapshot');
  return parsed as Record<string, unknown>[];
}

/** Fresh MVCC input observation, not an authorization or membership cache. */
export async function coordinationTickInput(
  db: Pick<Database, 'select'>,
  env: Env,
  options: { transaction?: boolean; now?: number } = {},
) {
  // The lightweight test fake does not implement SQL JSON aggregation.
  if (!options.transaction && !('$client' in db)) return null;
  const now = options.now ?? Date.now();
  // Explicit qualification keeps correlated references intact: Drizzle strips
  // column table names from a select projection, including nested SQL.
  const [input] = await db
    .select({
      sessions: sql<unknown>`(SELECT JSON_ARRAYAGG(JSON_OBJECT(
      'id', ${agentSessions.id}, 'hostId', ${agentSessions.hostId}, 'engine', ${agentSessions.engine},
      'addressId', ${agentSessions.agentBusAddressId}, 'generation', ${agentSessions.bindingGeneration},
      'endedAt', ${agentSessions.endedAt}, 'name', ${agentSessions.launchName}, 'workspace', ${agentSessions.workspace},
      'capabilities', ${agentSessions.adapterCapabilities}, 'cwd', ${agentSessions.cwd},
      'nativeId', ${agentSessions.upstreamSessionId}, 'heartbeat', ${agentSessions.heartbeatAt},
      'title', (SELECT ${agentEvents.payloadEnc} FROM ${agentEvents}
        WHERE ${sql.identifier('agent_events')}.${sql.identifier('session_id')} = ${sql.identifier('agent_sessions')}.${sql.identifier('id')} AND ${agentEvents.eventType} = 'session_named'
        ORDER BY ${agentEvents.id} DESC LIMIT 1)
    )) FROM ${agentSessions} WHERE ${agentSessions.endedAt} IS NULL OR ${sql.identifier('agent_sessions')}.${sql.identifier('id')} IN (
      SELECT ${agentScopeMembers.sessionId} FROM ${agentScopeMembers} WHERE ${agentScopeMembers.state} = 'active'))`,
      hosts: sql<unknown>`(SELECT JSON_ARRAYAGG(JSON_OBJECT(
      'id', ${hosts.id}, 'fqdn', ${hosts.fqdn}, 'status', ${hosts.status}, 'internalRole', ${hosts.internalRole},
      'engines', ${hosts.engines}, 'eligible', (${hosts.status} = 'active' AND
        (${hosts.secure} = 1 OR ${hosts.insecureEnabledUntil} >= ${new Date(now)}))
    )) FROM ${hosts})`,
      members: sql<unknown>`(SELECT JSON_ARRAYAGG(JSON_OBJECT(
      'id', ${agentScopeMembers.id}, 'scopeId', ${agentScopeMembers.scopeId}, 'sessionId', ${agentScopeMembers.sessionId},
      'generation', ${agentScopeMembers.generation}, 'protocol', ${agentScopeMembers.protocol},
      'contextHash', ${agentScopeMembers.contextHash}
    )) FROM ${agentScopeMembers} WHERE ${agentScopeMembers.state} = 'active')`,
      bindings: sql<unknown>`(SELECT JSON_ARRAYAGG(JSON_OBJECT('key', ${agentScopeBindings.repositoryKey},
      'project', ${agentScopeBindings.projectSlug})) FROM ${agentScopeBindings})`,
      scopes: sql<unknown>`(SELECT JSON_ARRAYAGG(JSON_OBJECT('id', ${agentScopes.id}, 'key', ${agentScopes.scopeKey})) FROM ${agentScopes})`,
      claims: sql<unknown>`(SELECT JSON_ARRAYAGG(JSON_OBJECT('id', ${agentResourceClaims.id},
      'sessionId', ${agentResourceClaims.sessionId}, 'generation', ${agentResourceClaims.generation},
      'expiresAt', ${agentResourceClaims.expiresAt})) FROM ${agentResourceClaims} WHERE ${agentResourceClaims.state} = 'active')`,
      flags: sql<unknown>`(SELECT JSON_ARRAYAGG(JSON_OBJECT('key', ${versions.name}, 'value', ${versions.version}))
      FROM ${versions} WHERE ${versions.name} IN ('agent_coordination_enabled', 'agent_messaging_enabled',
        'codex_engine_disabled', 'claude_engine_disabled', 'grok_engine_disabled'))`,
      pending: sql<number>`EXISTS (SELECT 1 FROM ${agentScopeEvents} WHERE ${agentScopeEvents.dispatched} = 0
      AND ${agentScopeEvents.createdAt} < ${new Date(now - 2000).toISOString()} LIMIT 1)`,
    })
    .from(sql`(SELECT 1) AS coordination_input`)
    .limit(1);
  if (!input) return null;
  const sessions = rows(input.sessions).map(({ heartbeat, ...session }) => ({
    ...session,
    present:
      !session.endedAt &&
      isFreshPresenceTimestamp(
        typeof heartbeat === 'string' ? heartbeat : null,
        now - env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS * 1000,
        now,
      ),
  }));
  const claims = rows(input.claims).map(({ expiresAt, ...claim }) => ({
    ...claim,
    expired: Date.parse(String(expiresAt)) <= now,
  }));
  const flags = rows(input.flags);
  const groups = {
    sessions,
    claims,
    flags,
    hosts: rows(input.hosts),
    members: rows(input.members),
    bindings: rows(input.bindings),
    scopes: rows(input.scopes),
  };
  const fingerprint = sha256(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(groups).map(([key, group]) => [
          key,
          group.map((row) => JSON.stringify(canonical(row))).sort(),
        ]),
      ),
    ),
  );
  return {
    fingerprint,
    // Reconciliation consumes these exact snapshot flags, never a cached or
    // fail-open engine read that could certify a different eligibility state.
    fleet: Object.freeze(
      Object.fromEntries(
        ENGINES.map((engine) => [
          engine,
          !isTruthyFlagValue(
            flags.find((flag) => flag.key === ENGINE_DISABLED_FLAGS[engine])?.value as string | null,
          ),
        ]),
      ),
    ) as FleetEngineState,
    pending: Boolean(input.pending),
    enabled:
      flags.some((flag) => flag.key === 'agent_coordination_enabled' && flag.value === '1') &&
      flags.some(
        (flag) =>
          flag.key === 'agent_messaging_enabled' && isTruthyFlagValue(flag.value as string | null, false),
      ),
  };
}

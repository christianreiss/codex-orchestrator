/**
 * Fleet-wide engine master switches.
 *
 * One switch per engine turns that engine off for the whole fleet: hosts can
 * no longer launch, lease, sync or tick it, the server stops refreshing,
 * verifying and polling its accounts, and any exposed API whose *backend* is
 * that engine answers 503. Turning it back on restores everything without a
 * reinstall — nothing is deleted, host engine assignments stay as they are.
 *
 * Storage follows the `openai_api_disabled` convention: `versions` rows
 * `<engine>_engine_disabled`, where a missing row means enabled, so existing
 * installs are unaffected and no migration is needed.
 *
 * Reads are cached per database handle for one second and invalidated by
 * every write in this process. A failed read serves the last value seen, or
 * "all enabled" if there is none — refusing every engine because the metadata
 * table glitched is worse than serving, which is how the other switches fail.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { hosts, logs, versions } from '../db/schema.js';
import { wsPublisher } from '../ws/publisher.js';
import { nowIso } from '../util/timestamp.js';
import { ENGINE_LABELS, ENGINES, isEngine, type Engine } from '../util/engine.js';
import { isTruthyFlagValue } from './settings.js';
import { suspendAgentMessagingRuntimeLocked } from './agent-messaging/bindings.js';
import {
  ALL_ENGINES_ENABLED,
  fleetEngineConflictError,
  fleetEngineDisabledError,
  hostEnginesList,
  type FleetEngineState,
} from './host-engine-policy.js';

export {
  ALL_ENGINES_ENABLED,
  activeHostEngines,
  disabledEngines,
  enabledEngines,
  fleetEngineConflictError,
  fleetEngineDisabledError,
  type FleetEngineState,
} from './host-engine-policy.js';

export const ENGINE_DISABLED_FLAGS: Readonly<Record<Engine, string>> = Object.freeze({
  codex: 'codex_engine_disabled',
  claude: 'claude_engine_disabled',
  grok: 'grok_engine_disabled',
});

export const ENGINE_STATE_AUDIT_ACTION = 'admin.engine.state';

const TTL_MS = 1_000;

interface CacheEntry {
  value: FleetEngineState;
  ts: number;
}

const caches = new WeakMap<object, CacheEntry>();

function parseState(rows: Array<{ name: string; version: string | null }>): FleetEngineState {
  const byName = new Map(rows.map((row) => [row.name, row.version]));
  const state = {} as Record<Engine, boolean>;
  for (const engine of ENGINES) {
    state[engine] = !isTruthyFlagValue(byName.get(ENGINE_DISABLED_FLAGS[engine]));
  }
  return Object.freeze(state);
}

/** Current fleet engine state (1 s cache per database handle). */
export async function readFleetEngineState(
  db: Pick<Database, 'select'>,
  options: { fresh?: boolean } = {},
): Promise<FleetEngineState> {
  const hit = caches.get(db);
  if (!options.fresh && hit && Date.now() - hit.ts < TTL_MS) return hit.value;
  try {
    const rows = await db
      .select({ name: versions.name, version: versions.version })
      .from(versions)
      .where(inArray(versions.name, ENGINES.map((engine) => ENGINE_DISABLED_FLAGS[engine])));
    const value = parseState(rows);
    caches.set(db, { value, ts: Date.now() });
    return value;
  } catch {
    return hit?.value ?? ALL_ENGINES_ENABLED;
  }
}

/** Drop the cached state, e.g. after a test wrote the flag rows directly. */
export function invalidateFleetEngineState(db: Database): void {
  caches.delete(db);
}

export async function isFleetEngineEnabled(db: Database, engine: Engine): Promise<boolean> {
  return (await readFleetEngineState(db))[engine];
}

/** Throws the fleet `engine_disabled` refusal when `engine` is switched off. */
export async function assertFleetEngineEnabled(db: Database, engine: Engine): Promise<void> {
  if (!(await readFleetEngineState(db))[engine]) throw fleetEngineDisabledError(engine);
}

/** Admin actions: throws the 409 fleet `engine_disabled` conflict when `engine` is switched off. */
export async function assertFleetEngineEnabledForAdmin(db: Database, engine: Engine): Promise<void> {
  if (!(await readFleetEngineState(db))[engine]) throw fleetEngineConflictError(engine);
}

export interface EngineStateRow {
  engine: Engine;
  label: string;
  enabled: boolean;
  updated_at: string | null;
  updated_by: string | null;
  /** Hosts that carry this engine in their assignment. */
  assigned_hosts: number;
}

/** The admin view: one row per engine with who flipped it last. */
export async function listEngineStates(db: Database): Promise<EngineStateRow[]> {
  const flagNames = ENGINES.map((engine) => ENGINE_DISABLED_FLAGS[engine]);
  const [flagRows, auditRows, hostRows] = await Promise.all([
    db
      .select({ name: versions.name, version: versions.version, updatedAt: versions.updatedAt })
      .from(versions)
      .where(inArray(versions.name, flagNames)),
    db
      .select({ details: logs.details })
      .from(logs)
      .where(eq(logs.action, ENGINE_STATE_AUDIT_ACTION))
      .orderBy(desc(logs.id))
      .limit(50),
    db.select({ engines: hosts.engines }).from(hosts).where(eq(hosts.status, 'active')),
  ]);
  const flags = new Map(flagRows.map((row) => [row.name, row]));
  const lastActor = new Map<Engine, string | null>();
  for (const row of auditRows) {
    try {
      const details = JSON.parse(row.details ?? '{}') as { engine?: unknown; actor?: unknown };
      if (isEngine(details.engine) && !lastActor.has(details.engine)) {
        lastActor.set(details.engine, typeof details.actor === 'string' ? details.actor : null);
      }
    } catch {
      /* a malformed audit row only loses the "by" column */
    }
  }
  const assigned = new Map<Engine, number>();
  for (const row of hostRows) {
    for (const engine of hostEnginesList(row.engines)) assigned.set(engine, (assigned.get(engine) ?? 0) + 1);
  }
  return ENGINES.map((engine) => {
    const flag = flags.get(ENGINE_DISABLED_FLAGS[engine]);
    return {
      engine,
      label: ENGINE_LABELS[engine],
      enabled: !isTruthyFlagValue(flag?.version),
      updated_at: flag?.updatedAt ?? null,
      updated_by: lastActor.get(engine) ?? null,
      assigned_hosts: assigned.get(engine) ?? 0,
    };
  });
}

export interface EngineStateChange {
  engine: Engine;
  enabled: boolean;
  previous: boolean;
  /** Hosts whose agent-messaging runtime for this engine was suspended. */
  hosts_suspended: number;
}

/**
 * Flip one engine's master switch.
 *
 * One transaction: the flag row, a `configVersion` bump on every host so the
 * signed wrapper config (which carries `fleet_disabled_engines`) is re-baked
 * on the next refresh, the audit row, and — on disable — the same messaging
 * suspension host-level engine removal applies, for every host that carries
 * the engine. Publishing happens after commit.
 */
export async function setFleetEngineEnabled(
  db: Database,
  engine: Engine,
  enabled: boolean,
  actor: string | null,
): Promise<EngineStateChange> {
  const flag = ENGINE_DISABLED_FLAGS[engine];
  const now = nowIso();
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ version: versions.version })
      .from(versions)
      .where(eq(versions.name, flag))
      .limit(1)
      .for('update');
    const previous = !isTruthyFlagValue(rows[0]?.version);
    const value = enabled ? '0' : '1';
    if (rows.length === 0) {
      await tx.insert(versions).values({ name: flag, version: value, updatedAt: now });
    } else {
      await tx.update(versions).set({ version: value, updatedAt: now }).where(eq(versions.name, flag));
    }
    if (previous === enabled) {
      return { previous, hostsSuspended: 0 };
    }
    await tx.update(hosts).set({ configVersion: sql`${hosts.configVersion} + 1`, updatedAt: now });
    let hostsSuspended = 0;
    if (!enabled) {
      const carrying = await tx.select({ id: hosts.id, engines: hosts.engines }).from(hosts);
      for (const host of carrying) {
        if (!hostEnginesList(host.engines).includes(engine)) continue;
        await suspendAgentMessagingRuntimeLocked(tx, host.id, 'engine_disabled', [engine]);
        hostsSuspended += 1;
      }
    }
    await tx.insert(logs).values({
      hostId: null,
      action: ENGINE_STATE_AUDIT_ACTION,
      details: JSON.stringify({ engine, enabled, previous, actor, hosts_suspended: hostsSuspended }),
      createdAt: now,
    });
    return { previous, hostsSuspended };
  });
  invalidateFleetEngineState(db);
  if (result.previous !== enabled) {
    wsPublisher.publish('engine.state.changed', { engine, enabled });
    wsPublisher.publish('settings.changed', { key: flag });
  }
  return { engine, enabled, previous: result.previous, hosts_suspended: result.hostsSuspended };
}

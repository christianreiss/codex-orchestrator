/**
 * How many hosts override each fleet-wide setting, for the Settings overview.
 * Read-only: one pass over `hosts` and one over the `versions` rows that hold
 * per-host RTK and session-housekeeping overrides (`rtk_<engine>_host_<id>`,
 * `session_housekeeping_<engine>_host_<id>`). Rows for hosts that no longer
 * exist are not counted. No credentials or per-host detail leave this module.
 */

import { like, or } from 'drizzle-orm';
import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import type { Database } from '../db/client.js';
import { hosts, versions } from '../db/schema.js';
import { ENGINES, type Engine } from '../util/engine.js';

export interface HostOverrideCounts {
  /** Hosts with their own auto-update choice. */
  auto_update: number;
  /** Hosts with their own reverse-DNS mode. */
  reverse_dns: number;
  rtk: Record<Engine, number>;
  session_housekeeping: Record<Engine, number>;
}

const ENGINE_PATTERN = ENGINES.join('|');
const RTK_KEY = new RegExp(`^rtk_(${ENGINE_PATTERN})_host_(\\d+)$`);
const HOUSEKEEPING_KEY = new RegExp(`^session_housekeeping_(${ENGINE_PATTERN})_host_(\\d+)$`);

const perEngine = (): Record<Engine, number> => Object.fromEntries(ENGINES.map((e) => [e, 0])) as Record<Engine, number>;

/** Pure counting step: unit-testable without a database. */
export function countHostOverrides(
  hostRows: ReadonlyArray<{ id: number; autoUpdateOverride: number | null; reverseDnsMode: number | null }>,
  settingRows: ReadonlyArray<{ name: string; version: string | null }>,
): HostOverrideCounts {
  const known = new Set(hostRows.map((h) => h.id));
  const counts: HostOverrideCounts = {
    auto_update: hostRows.filter((h) => h.autoUpdateOverride != null).length,
    reverse_dns: hostRows.filter((h) => h.reverseDnsMode != null).length,
    rtk: perEngine(),
    session_housekeeping: perEngine(),
  };
  for (const row of settingRows) {
    if (row.version == null || row.version === '') continue;
    const rtk = RTK_KEY.exec(row.name);
    if (rtk && known.has(Number(rtk[2]))) counts.rtk[rtk[1] as Engine] += 1;
    const keeping = HOUSEKEEPING_KEY.exec(row.name);
    if (keeping && known.has(Number(keeping[2]))) counts.session_housekeeping[keeping[1] as Engine] += 1;
  }
  return counts;
}

export async function readHostOverrideCounts(db: Database): Promise<HostOverrideCounts> {
  const owner = ownerRuntimeFor(db);
  if (owner) {
    owner.assertOwner();
    const snapshot = owner.state.snapshot();
    return countHostOverrides(
      snapshot.hosts.all(),
      snapshot.settings.all().map((row) => ({ name: row.name, version: row.version })),
    );
  }
  const hostRows = await db
    .select({ id: hosts.id, autoUpdateOverride: hosts.autoUpdateOverride, reverseDnsMode: hosts.reverseDnsMode })
    .from(hosts);
  const settingRows = await db
    .select({ name: versions.name, version: versions.version })
    .from(versions)
    .where(or(like(versions.name, 'rtk\\_%\\_host\\_%'), like(versions.name, 'session\\_housekeeping\\_%\\_host\\_%')));
  return countHostOverrides(hostRows, settingRows);
}

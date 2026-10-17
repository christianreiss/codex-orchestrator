/**
 * Server-owned hosts.
 *
 * The Fleet Advisor runs in the stack's own `advisor` container, which needs a
 * host row only so the host daemon, engine auth and the agent bus work for it.
 * That row is not part of the fleet: no admin listing, count, discovery or
 * spawn target may show it, and pruning never touches it. Every such surface
 * filters with `visibleHost`.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { hosts, type Host } from '../db/schema.js';

export const ADVISOR_ROLE = 'advisor';
export const ADVISOR_FQDN = 'advisor.internal';

/** Drizzle predicate: the host is an ordinary fleet host. */
export const visibleHost: SQL = isNull(hosts.internalRole);

/** Raw-SQL predicate on a `hosts` alias, for hand-written queries. */
export function visibleHostSql(alias = 'hosts'): SQL {
  return sql.raw(`${alias}.internal_role IS NULL`);
}

export function isInternalHost(host: Pick<Host, 'internalRole'> | null | undefined): boolean {
  return Boolean(host?.internalRole);
}

/** Ids of every server-owned host, for filtering rows that only carry a host id. */
export async function internalHostIds(db: Database): Promise<number[]> {
  const rows = await db.select({ id: hosts.id, internalRole: hosts.internalRole }).from(hosts);
  return rows.filter((row) => row.internalRole).map((row) => row.id);
}

export async function advisorHost(db: Database): Promise<Host | null> {
  const [row] = await db
    .select()
    .from(hosts)
    .where(and(eq(hosts.internalRole, ADVISOR_ROLE), eq(hosts.status, 'active')))
    .limit(1);
  return row ?? null;
}

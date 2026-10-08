import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { agentBusAddresses, agentNameLeases, agentNamePool, agentSessions } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import type { AgentMessagingDb } from './types.js';

export function agentNameKey(value: string): string {
  return value
    .trim()
    .normalize('NFC')
    .toLowerCase()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss');
}

export const AGENT_NAME_COOLDOWN_SECONDS = 86_400;
type Lease = typeof agentNameLeases.$inferSelect;
type Session = Pick<typeof agentSessions.$inferSelect, 'endedAt' | 'bridgeExpiresAt'>;

// Expiry is terminal for the name lease even before the portal reaper observes it.
// A brief loss of presence alone never ends a lease.
export function nameLeaseState(lease: Lease, session: Session | null, now: string) {
  const endedAt =
    lease.endedAt ??
    session?.endedAt ??
    (session && session.bridgeExpiresAt <= now ? session.bridgeExpiresAt : null);
  const cooldownUntil =
    lease.cooldownUntil ??
    (endedAt ? isoOffsetSeconds(AGENT_NAME_COOLDOWN_SECONDS, new Date(endedAt)) : null);
  return { endedAt, cooldownUntil, reserved: !cooldownUntil || cooldownUntil > now };
}

export function namedSessionTitle(name: string | null | undefined, title: string | null): string | null {
  if (!name) return title;
  const prefix = `(${name})`;
  const task = (title ?? '').trim();
  return task === prefix || task.startsWith(`${prefix} `) ? task : `${prefix}${task ? ` ${task}` : ''}`;
}

// All name writers lock the pool in the same order, after their session/address
// locks. Allocations are infrequent; serializing this small pool also prevents
// alias races and duplicate leases without a DB-specific partial unique index.
async function lockPool(db: AgentMessagingDb) {
  return await db.select().from(agentNamePool).orderBy(asc(agentNamePool.nameKey)).for('update');
}

export async function assignLaunchNameLocked(
  db: AgentMessagingDb,
  sessionId: string,
  addressId: string,
  now: string,
): Promise<string | null> {
  const pool = await lockPool(db);
  const [existing] = await db
    .select()
    .from(agentNameLeases)
    .where(eq(agentNameLeases.sessionId, sessionId))
    .for('update');
  if (existing) {
    const slot = pool.find((row) => row.nameKey === existing.nameKey);
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    if (
      session?.endedAt ||
      (existing.cooldownUntil && existing.cooldownUntil <= now) ||
      slot?.currentSessionId !== sessionId
    )
      throw new ConflictError('Launch name lease has ended; start a new lifecycle', 'agent_session_finished');
    await db
      .update(agentNameLeases)
      .set({ addressId, endedAt: null, cooldownUntil: null })
      .where(eq(agentNameLeases.sessionId, sessionId));
    return existing.name;
  }
  const currentIds = pool.flatMap((row) => (row.currentSessionId ? [row.currentSessionId] : []));
  const rows = currentIds.length
    ? await db
        .select({ lease: agentNameLeases, session: agentSessions })
        .from(agentNameLeases)
        .leftJoin(agentSessions, eq(agentSessions.id, agentNameLeases.sessionId))
        .where(inArray(agentNameLeases.sessionId, currentIds))
    : [];
  const current = new Map(rows.map((row) => [row.lease.sessionId, row]));
  const aliases = await db.select({ alias: agentBusAddresses.displayAlias }).from(agentBusAddresses);
  const blocked = new Set(
    aliases.flatMap((row) => (row.alias ? [agentNameKey(row.alias.replace(/^agent:/, ''))] : [])),
  );
  const free = pool.filter((slot) => {
    if (blocked.has(slot.nameKey)) return false;
    if (!slot.currentSessionId) return true;
    const previous = current.get(slot.currentSessionId);
    return previous && !nameLeaseState(previous.lease, previous.session, now).reserved;
  });
  if (!free.length) return null;
  const slot = free[randomInt(free.length)]!;
  const previous = slot.currentSessionId ? current.get(slot.currentSessionId) : undefined;
  if (previous) {
    const state = nameLeaseState(previous.lease, previous.session, now);
    await db
      .update(agentNameLeases)
      .set({ endedAt: state.endedAt, cooldownUntil: state.cooldownUntil })
      .where(eq(agentNameLeases.sessionId, previous.lease.sessionId));
  }
  await db
    .insert(agentNameLeases)
    .values({
      sessionId,
      nameKey: slot.nameKey,
      name: slot.name,
      addressId,
      startedAt: now,
      endedAt: null,
      cooldownUntil: null,
    });
  await db
    .update(agentNamePool)
    .set({ currentSessionId: sessionId })
    .where(eq(agentNamePool.nameKey, slot.nameKey));
  return slot.name;
}

export async function endLaunchNamesLocked(db: AgentMessagingDb, sessionIds: string[], now: string) {
  if (!sessionIds.length) return;
  // Lock the pool in key order; unnamed legacy sessions do no work.
  const leases = await db
    .select()
    .from(agentNameLeases)
    .where(and(inArray(agentNameLeases.sessionId, sessionIds), isNull(agentNameLeases.endedAt)));
  if (!leases.length) return;
  await lockPool(db);
  for (const lease of leases) {
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, lease.sessionId));
    const endedAt =
      session?.endedAt ?? (session && session.bridgeExpiresAt <= now ? session.bridgeExpiresAt : now);
    await db
      .update(agentNameLeases)
      .set({ endedAt, cooldownUntil: isoOffsetSeconds(AGENT_NAME_COOLDOWN_SECONDS, new Date(endedAt)) })
      .where(and(eq(agentNameLeases.sessionId, lease.sessionId), isNull(agentNameLeases.endedAt)));
  }
}

export async function moveLaunchNameLocked(
  db: AgentMessagingDb,
  sessionId: string,
  addressId: string,
  now: string,
) {
  const [lease] = await db.select().from(agentNameLeases).where(eq(agentNameLeases.sessionId, sessionId));
  if (!lease) return null;
  const name = await assignLaunchNameLocked(db, sessionId, addressId, now);
  await db.update(agentBusAddresses).set({ launchName: name }).where(eq(agentBusAddresses.id, addressId));
  return name;
}

export async function assertAliasOutsideNamePool(db: AgentMessagingDb, alias: string | null) {
  if (!alias) return;
  const key = agentNameKey(alias.replace(/^agent:/, ''));
  const [slot] = await db.select().from(agentNamePool).where(eq(agentNamePool.nameKey, key)).for('update');
  if (slot)
    throw new ConflictError('Alias is reserved for automatic launch names', 'agent_messaging_alias_reserved');
}

export async function translateAgent(
  db: AgentMessagingDb,
  raw: string,
  forUpdate = false,
): Promise<Record<string, unknown>> {
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 96)
    throw new ValidationError('value must contain 1–96 characters', { param: 'value' });
  const uuid = /^(?:agent:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(value)?.[1];
  let lease: Lease | undefined;
  if (uuid) {
    const [address] = await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, uuid));
    const [row] = await db
      .select()
      .from(agentNameLeases)
      .where(
        and(
          eq(agentNameLeases.addressId, uuid),
          ...(address?.currentSessionId
            ? [eq(agentNameLeases.sessionId, address.currentSessionId)]
            : address?.launchName
              ? [eq(agentNameLeases.name, address.launchName)]
              : []),
        ),
      )
      .orderBy(desc(agentNameLeases.startedAt), desc(agentNameLeases.sessionId))
      .limit(1);
    lease = row;
  } else {
    const query = db
      .select()
      .from(agentNamePool)
      .where(eq(agentNamePool.nameKey, agentNameKey(value)));
    const [slot] = forUpdate ? await query.for('update') : await query;
    if (slot?.currentSessionId) {
      const [row] = await db
        .select()
        .from(agentNameLeases)
        .where(eq(agentNameLeases.sessionId, slot.currentSessionId));
      lease = row;
    }
  }
  if (!lease) throw new NotFoundError('No launch name assignment found', 'agent_name_not_found');
  const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, lease.sessionId));
  const now = nowIso();
  const state = nameLeaseState(lease, session ?? null, now);
  if (!uuid && !state.reserved)
    throw new NotFoundError('Name is free; use the previous agent UUID', 'agent_name_not_found');
  return {
    name: lease.name,
    uuid: lease.addressId,
    address: `agent:${lease.addressId}`,
    session_id: lease.sessionId,
    status: state.endedAt ? 'ended' : 'active',
    started_at: lease.startedAt,
    ended_at: state.endedAt,
    cooldown_until: state.cooldownUntil,
    direction: uuid ? 'uuid_to_name' : 'name_to_uuid',
  };
}

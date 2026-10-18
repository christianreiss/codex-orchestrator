import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
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
  const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
  if (session?.endedAt)
    throw new ConflictError('Launch name lease has ended; start a new lifecycle', 'agent_session_finished');
  const [existing] = await db
    .select()
    .from(agentNameLeases)
    .where(
      and(
        eq(agentNameLeases.sessionId, sessionId),
        ...(session?.launchName ? [eq(agentNameLeases.name, session.launchName)] : []),
      ),
    )
    .orderBy(desc(agentNameLeases.id))
    .limit(1);
  // The address is resolved from a proven native transcript, never cwd/recency.
  // Prefer its first name even when older releases renamed it on every resume.
  const [original] = await db
    .select()
    .from(agentNameLeases)
    .where(and(eq(agentNameLeases.addressId, addressId), ne(agentNameLeases.sessionId, sessionId)))
    .orderBy(asc(agentNameLeases.startedAt), asc(agentNameLeases.id))
    .limit(1);
  const preferred = existing?.addressId === addressId ? existing : (original ?? existing);
  const currentIds = pool.flatMap((row) => (row.currentSessionId ? [row.currentSessionId] : []));
  const rows = currentIds.length
    ? await db
        .select({ lease: agentNameLeases, session: agentSessions })
        .from(agentNameLeases)
        .leftJoin(agentSessions, eq(agentSessions.id, agentNameLeases.sessionId))
        .where(inArray(agentNameLeases.sessionId, currentIds))
        .orderBy(desc(agentNameLeases.id))
    : [];
  const current = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.lease.nameKey}:${row.lease.sessionId}`;
    if (!current.has(key)) current.set(key, row);
  }
  const ownerOf = (slot: (typeof pool)[number]) =>
    slot.currentSessionId ? current.get(`${slot.nameKey}:${slot.currentSessionId}`) : undefined;
  const aliases = await db.select({ alias: agentBusAddresses.displayAlias }).from(agentBusAddresses);
  const blocked = new Set(
    aliases.flatMap((row) => (row.alias ? [agentNameKey(row.alias.replace(/^agent:/, ''))] : [])),
  );
  let slot = preferred ? pool.find((row) => row.nameKey === preferred.nameKey) : undefined;
  if (preferred) {
    const owner = slot && ownerOf(slot);
    const state = owner && nameLeaseState(owner.lease, owner.session, now);
    const ownedHere = slot?.currentSessionId === sessionId && owner?.lease.id === existing?.id;
    const reclaimOwn = owner?.lease.addressId === addressId && !!state?.endedAt;
    if (
      !slot ||
      blocked.has(preferred.nameKey) ||
      (!ownedHere && !reclaimOwn && slot.currentSessionId && (!state || state.reserved))
    ) {
      throw new ConflictError(
        `Cannot resume ${preferred.name}: the name is assigned to another agent. Retry when it is free; identity remains agent:${addressId}`,
        'agent_resume_name_conflict',
        { name: preferred.name, address: `agent:${addressId}`, uuid: addressId },
      );
    }
    if (ownedHere && existing) {
      if (existing.cooldownUntil && existing.cooldownUntil <= now)
        throw new ConflictError(
          'Launch name lease has ended; start a new lifecycle',
          'agent_session_finished',
        );
      await db
        .update(agentNameLeases)
        .set({ addressId, endedAt: null, cooldownUntil: null })
        .where(eq(agentNameLeases.id, existing.id));
      return existing.name;
    }
  } else {
    const free = pool.filter((candidate) => {
      if (blocked.has(candidate.nameKey)) return false;
      if (!candidate.currentSessionId) return true;
      const owner = ownerOf(candidate);
      return owner && !nameLeaseState(owner.lease, owner.session, now).reserved;
    });
    if (!free.length) return null;
    slot = free[randomInt(free.length)]!;
  }
  const previous = ownerOf(slot!);
  if (previous) {
    const state = nameLeaseState(previous.lease, previous.session, now);
    await db
      .update(agentNameLeases)
      .set({ endedAt: state.endedAt, cooldownUntil: state.cooldownUntil })
      .where(eq(agentNameLeases.id, previous.lease.id));
  }
  // Picker/continue can replace a provisional name. Retain its assignment and
  // quarantine independently of the restored name, even in this same launch.
  if (existing && existing.nameKey !== slot!.nameKey) {
    await db
      .update(agentNameLeases)
      .set({ endedAt: now, cooldownUntil: isoOffsetSeconds(AGENT_NAME_COOLDOWN_SECONDS, new Date(now)) })
      .where(eq(agentNameLeases.id, existing.id));
  }
  await db.insert(agentNameLeases).values({
    sessionId,
    nameKey: slot!.nameKey,
    name: slot!.name,
    addressId,
    startedAt: now,
    endedAt: null,
    cooldownUntil: null,
  });
  await db
    .update(agentNamePool)
    .set({ currentSessionId: sessionId })
    .where(eq(agentNamePool.nameKey, slot!.nameKey));
  return slot!.name;
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
      .where(and(eq(agentNameLeases.id, lease.id), isNull(agentNameLeases.endedAt)));
  }
}

export async function moveLaunchNameLocked(
  db: AgentMessagingDb,
  sessionId: string,
  addressId: string,
  now: string,
) {
  const [lease] = await db
    .select()
    .from(agentNameLeases)
    .where(eq(agentNameLeases.sessionId, sessionId))
    .limit(1);
  if (!lease) return null;
  const name = await assignLaunchNameLocked(db, sessionId, addressId, now);
  await db.update(agentBusAddresses).set({ launchName: name }).where(eq(agentBusAddresses.id, addressId));
  await db.update(agentSessions).set({ launchName: name }).where(eq(agentSessions.id, sessionId));
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
            ? [
                eq(agentNameLeases.sessionId, address.currentSessionId),
                ...(address.launchName ? [eq(agentNameLeases.name, address.launchName)] : []),
              ]
            : address?.launchName
              ? [eq(agentNameLeases.name, address.launchName)]
              : []),
        ),
      )
      .orderBy(desc(agentNameLeases.startedAt), desc(agentNameLeases.id))
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
        .where(
          and(
            eq(agentNameLeases.sessionId, slot.currentSessionId),
            eq(agentNameLeases.nameKey, slot.nameKey),
          ),
        )
        .orderBy(desc(agentNameLeases.id))
        .limit(1);
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

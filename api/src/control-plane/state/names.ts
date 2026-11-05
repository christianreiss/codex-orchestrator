import { randomInt } from 'node:crypto';
import { agentNameLeases } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import { AGENT_NAME_COOLDOWN_SECONDS, agentNameKey } from '../../services/agent-messaging/names.js';
import { isoOffsetSeconds } from '../../util/timestamp.js';
import type { OwnerMutationContext } from './runtime.js';
import type { OwnerStateSnapshot } from './store.js';
import { stageUpdate } from './rows.js';

/** Credential expiry and transport loss do not end a native lifecycle or its name. */
export function ownedNameLeaseState(
  lease: { endedAt: string | null; cooldownUntil: string | null },
  session: { endedAt: string | null } | null,
  now: string,
) {
  const endedAt = lease.endedAt ?? session?.endedAt ?? null;
  const cooldownUntil =
    lease.cooldownUntil ??
    (endedAt ? isoOffsetSeconds(AGENT_NAME_COOLDOWN_SECONDS, new Date(endedAt)) : null);
  return { endedAt, cooldownUntil, reserved: !cooldownUntil || cooldownUntil > now };
}

export function stageLaunchName(
  context: OwnerMutationContext,
  sessionId: string,
  addressId: string,
  now: string,
  outcome?: { renamedFrom?: string },
): string | null {
  const { draft } = context;
  const session = draft.table('agentSessions').get(sessionId);
  if (!session || session.endedAt)
    throw new ConflictError('Launch name lease has ended; start a new lifecycle', 'agent_session_finished');
  const leases = draft.table('agentNameLeases');
  const existing = leases
    .by('sessionId', sessionId)
    .filter((row) => !session.launchName || row.name === session.launchName)
    .sort((a, b) => b.id - a.id)[0];
  const original = leases
    .by('addressId', addressId)
    .filter((row) => row.sessionId !== sessionId)
    // The address's current name is its newest lease: after a reassigned name
    // was replaced, resumes keep the replacement instead of chasing the old one.
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id)[0];
  const preferred = existing?.addressId === addressId ? existing : (original ?? existing);
  const pool = draft.table('agentNamePool').all();
  const ownerOf = (slot: (typeof pool)[number]) =>
    slot.currentSessionId
      ? leases
          .by('sessionId', slot.currentSessionId)
          .filter((row) => row.nameKey === slot.nameKey)
          .sort((a, b) => b.id - a.id)[0]
      : undefined;
  const stateOf = (lease: NonNullable<ReturnType<typeof ownerOf>>) =>
    ownedNameLeaseState(lease, draft.table('agentSessions').get(lease.sessionId) ?? null, now);
  const blocked = new Set(
    draft
      .table('agentBusAddresses')
      .all()
      .flatMap((row) => (row.displayAlias ? [agentNameKey(row.displayAlias.replace(/^agent:/, ''))] : [])),
  );
  let slot = preferred ? pool.find((row) => row.nameKey === preferred.nameKey) : undefined;
  let takeFree = !preferred;
  if (preferred) {
    const owner = slot && ownerOf(slot),
      state = owner && stateOf(owner);
    const ownedHere = slot?.currentSessionId === sessionId && owner?.id === existing?.id;
    // A resume that already took the address from a detached holder (the
    // caller checked detachedHolderReplaceable) takes the address's name too.
    const displaced =
      !!owner &&
      owner.addressId === addressId &&
      owner.sessionId !== sessionId &&
      draft.table('agentBusAddresses').get(addressId)?.currentSessionId === sessionId;
    const reclaimOwn = owner?.addressId === addressId && (!!state?.endedAt || displaced);
    if (
      !slot ||
      blocked.has(preferred.nameKey) ||
      (!ownedHere && !reclaimOwn && slot.currentSessionId && (!state || state.reserved))
    ) {
      // The name outlived its 24-hour quarantine and now belongs to another
      // agent. The identity (UUID, address, history) stays; it continues under
      // a fresh name and is told so, so it renames its session and announces it.
      takeFree = true;
      if (outcome) outcome.renamedFrom = preferred.name;
    } else if (ownedHere && existing && existing.addressId === addressId) {
      stageUpdate(context, 'agentNameLeases', existing.id, { endedAt: null, cooldownUntil: null });
      return existing.name;
    }
  }
  if (takeFree) {
    const free = pool.filter((candidate) => {
      if (blocked.has(candidate.nameKey)) return false;
      if (!candidate.currentSessionId) return true;
      const owner = ownerOf(candidate);
      return owner && !stateOf(owner).reserved;
    });
    if (!free.length) return null;
    slot = free[randomInt(free.length)]!;
  }
  const previous = ownerOf(slot!);
  if (previous) {
    const state = stateOf(previous);
    // A displaced holder's lease ends now; nothing else would ever close it.
    const endedAt = state.endedAt ?? (previous.sessionId !== sessionId ? now : null);
    stageUpdate(context, 'agentNameLeases', previous.id, {
      endedAt,
      cooldownUntil: state.cooldownUntil ?? (state.endedAt ? null : endedAt),
    });
  }
  if (existing && existing.nameKey !== slot!.nameKey)
    stageUpdate(context, 'agentNameLeases', existing.id, {
      endedAt: now,
      cooldownUntil: isoOffsetSeconds(AGENT_NAME_COOLDOWN_SECONDS, new Date(now)),
    });
  const lease = {
    sessionId,
    nameKey: slot!.nameKey,
    name: slot!.name,
    addressId,
    startedAt: now,
    endedAt: null,
    cooldownUntil: null,
  };
  context.write(async (tx) => {
    const [inserted] = await tx.insert(agentNameLeases).values(lease);
    const id = Number(inserted.insertId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Name lease insert returned no safe identity');
    draft.upsert('agentNameLeases', { ...lease, id });
  });
  stageUpdate(context, 'agentNamePool', slot!.nameKey, { currentSessionId: sessionId });
  return slot!.name;
}

export function stageEndNames(context: OwnerMutationContext, sessionId: string, now: string): void {
  const session = context.draft.table('agentSessions').get(sessionId);
  for (const lease of context.draft.table('agentNameLeases').by('sessionId', sessionId)) {
    if (lease.endedAt) continue;
    const endedAt = session?.endedAt ?? now;
    stageUpdate(context, 'agentNameLeases', lease.id, {
      endedAt,
      cooldownUntil: isoOffsetSeconds(AGENT_NAME_COOLDOWN_SECONDS, new Date(endedAt)),
    });
  }
}

export function translateOwnedAgent(
  snapshot: OwnerStateSnapshot,
  raw: string,
  now: string,
): Record<string, unknown> {
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 96)
    throw new ValidationError('value must contain 1–96 characters', { param: 'value' });
  const uuid = /^(?:agent:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(value)?.[1];
  const leases = snapshot.table('agentNameLeases');
  let lease: ReturnType<typeof leases.get>;
  if (uuid) {
    const address = snapshot.addresses.get(uuid);
    lease = leases
      .by('addressId', uuid)
      .filter(
        (row) =>
          (!address?.currentSessionId || row.sessionId === address.currentSessionId) &&
          (!address?.launchName || row.name === address.launchName),
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id)[0];
  } else {
    const slot = snapshot.table('agentNamePool').get(agentNameKey(value));
    if (slot?.currentSessionId)
      lease = leases
        .by('sessionId', slot.currentSessionId)
        .filter((row) => row.nameKey === slot.nameKey)
        .sort((a, b) => b.id - a.id)[0];
  }
  if (!lease) throw new NotFoundError('No launch name assignment found', 'agent_name_not_found');
  const state = ownedNameLeaseState(lease, snapshot.sessions.get(lease.sessionId) ?? null, now);
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

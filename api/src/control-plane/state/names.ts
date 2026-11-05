import { randomInt } from 'node:crypto';
import { agentNameLeases } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import { AGENT_NAME_COOLDOWN_SECONDS, agentNameKey } from '../../services/agent-messaging/names.js';
import { ENGINE_EXTERNAL } from '../../util/engine.js';
import { isoOffsetSeconds } from '../../util/timestamp.js';
import { ownedAddress } from './messaging.js';
import type { OwnerMutationContext } from './runtime.js';
import type { OwnerStateSnapshot } from './store.js';
import { stageUpdate } from './rows.js';

type AddressRow = ReturnType<OwnerStateSnapshot['addresses']['all']>[number];

/**
 * An external client's address carries its configured name (docs/external-clients.md).
 * The name stays reserved while that address holds it: the pool never hands it to a
 * fleet launch, and a name lookup resolves to the client before any pool holder.
 */
function externalNameHolders(addresses: readonly AddressRow[], nameKey?: string): AddressRow[] {
  return addresses.filter(
    (row) =>
      row.engine === ENGINE_EXTERNAL &&
      row.enabled === 1 &&
      !row.archivedAt &&
      !!row.launchName &&
      (nameKey === undefined || agentNameKey(row.launchName) === nameKey),
  );
}

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
  fixedName?: string | null,
): string | null {
  const { draft } = context;
  const session = draft.table('agentSessions').get(sessionId);
  if (!session || session.endedAt)
    throw new ConflictError('Launch name lease has ended; start a new lifecycle', 'agent_session_finished');
  if (fixedName) return stageFixedName(context, sessionId, addressId, now, fixedName);
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
  const addresses = draft.table('agentBusAddresses').all();
  const blocked = new Set([
    ...addresses.flatMap((row) => (row.displayAlias ? [agentNameKey(row.displayAlias.replace(/^agent:/, ''))] : [])),
    ...externalNameHolders(addresses)
      .filter((row) => row.id !== addressId)
      .map((row) => agentNameKey(row.launchName!)),
  ]);
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

/**
 * Give an external client's address its configured name. The client takes
 * precedence over any fleet hold on the name: a pool holder (active, or ended
 * and still in quarantine) is released in this mutation, and a still-live
 * holder continues under a fresh pool name exactly like a resume whose name was
 * reassigned (`renamedFrom`). Its UUID, address and history stay.
 */
function stageFixedName(
  context: OwnerMutationContext,
  sessionId: string,
  addressId: string,
  now: string,
  raw: string,
): string {
  const { draft } = context;
  const name = raw.trim(),
    nameKey = agentNameKey(name);
  if (!name) throw new ValidationError('fixed name is required', { param: 'name' });
  if (
    externalNameHolders(draft.table('agentBusAddresses').by('engine', ENGINE_EXTERNAL), nameKey).some(
      (row) => row.id !== addressId,
    )
  )
    throw new ConflictError('Another external client holds this name', 'external_client_name_taken');
  const leases = draft.table('agentNameLeases');
  const slot = draft.table('agentNamePool').get(nameKey);
  let renamed: { sessionId: string; addressId: string } | undefined;
  if (slot?.currentSessionId && slot.currentSessionId !== sessionId) {
    const holder = leases
      .by('sessionId', slot.currentSessionId)
      .filter((row) => row.nameKey === nameKey)
      .sort((a, b) => b.id - a.id)[0];
    const holderSession = draft.table('agentSessions').get(slot.currentSessionId);
    if (holder) {
      const state = ownedNameLeaseState(holder, holderSession ?? null, now);
      // Released now: the quarantine protected the name for its holder, and the
      // external client owns it outright.
      stageUpdate(context, 'agentNameLeases', holder.id, {
        endedAt: state.endedAt ?? now,
        cooldownUntil: state.cooldownUntil && state.cooldownUntil < now ? state.cooldownUntil : now,
      });
    }
    const holderAddress = holder && draft.table('agentBusAddresses').get(holder.addressId);
    if (holder && holderAddress && holder.addressId !== addressId) {
      if (
        holderSession &&
        !holderSession.endedAt &&
        holderSession.launchName &&
        agentNameKey(holderSession.launchName) === nameKey &&
        holderAddress.currentSessionId === holderSession.id
      )
        renamed = { sessionId: holderSession.id, addressId: holderAddress.id };
      else if (holderAddress.launchName && agentNameKey(holderAddress.launchName) === nameKey)
        stageUpdate(context, 'agentBusAddresses', holderAddress.id, { launchName: null });
    }
  }
  if (slot && slot.currentSessionId !== sessionId)
    stageUpdate(context, 'agentNamePool', nameKey, { currentSessionId: sessionId });
  let mine: ReturnType<typeof leases.get>;
  for (const lease of [...leases.by('sessionId', sessionId)].sort((a, b) => b.id - a.id)) {
    if (!mine && lease.name === name && lease.addressId === addressId) {
      mine = lease;
      continue;
    }
    // A previous (pool or configured) name of this lifecycle ends with the usual quarantine.
    if (!lease.endedAt)
      stageUpdate(context, 'agentNameLeases', lease.id, {
        endedAt: now,
        cooldownUntil: isoOffsetSeconds(AGENT_NAME_COOLDOWN_SECONDS, new Date(now)),
      });
  }
  if (mine) {
    if (mine.endedAt || mine.cooldownUntil)
      stageUpdate(context, 'agentNameLeases', mine.id, { endedAt: null, cooldownUntil: null });
  } else {
    const lease = { sessionId, nameKey, name, addressId, startedAt: now, endedAt: null, cooldownUntil: null };
    context.write(async (tx) => {
      const [inserted] = await tx.insert(agentNameLeases).values(lease);
      const id = Number(inserted.insertId);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Name lease insert returned no safe identity');
      draft.upsert('agentNameLeases', { ...lease, id });
    });
  }
  if (renamed) {
    // The pool slot already points at the client, so the holder's resume logic
    // sees its name taken and picks a fresh one (or none when the pool is dry).
    const replacement = stageLaunchName(context, renamed.sessionId, renamed.addressId, now, {});
    stageUpdate(context, 'agentSessions', renamed.sessionId, { launchName: replacement });
    stageUpdate(context, 'agentBusAddresses', renamed.addressId, { launchName: replacement });
  }
  return name;
}

/**
 * Release an external client's configured name (client disabled, renamed or
 * deleted): its leases end without quarantine, its pool slot is freed and the
 * address loses the name until the next registration.
 */
export function stageReleaseFixedName(context: OwnerMutationContext, addressId: string, now: string): boolean {
  const { draft } = context;
  const address = draft.table('agentBusAddresses').get(addressId);
  if (!address || address.engine !== ENGINE_EXTERNAL) return false;
  let changed = false;
  for (const lease of draft.table('agentNameLeases').by('addressId', addressId)) {
    if (lease.endedAt && lease.cooldownUntil && lease.cooldownUntil <= now) continue;
    stageUpdate(context, 'agentNameLeases', lease.id, { endedAt: lease.endedAt ?? now, cooldownUntil: now });
    const slot = draft.table('agentNamePool').get(lease.nameKey);
    if (slot?.currentSessionId === lease.sessionId)
      stageUpdate(context, 'agentNamePool', lease.nameKey, { currentSessionId: null });
    changed = true;
  }
  if (address.launchName) {
    stageUpdate(context, 'agentBusAddresses', addressId, { launchName: null });
    if (address.currentSessionId && draft.table('agentSessions').get(address.currentSessionId))
      stageUpdate(context, 'agentSessions', address.currentSessionId, { launchName: null });
    changed = true;
  }
  return changed;
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
  let fixed = false;
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
    const nameKey = agentNameKey(value),
      at = Date.parse(now);
    const stateOf = (row: NonNullable<typeof lease>) =>
      ownedNameLeaseState(row, snapshot.sessions.get(row.sessionId) ?? null, now);
    const named = (address: AddressRow) =>
      leases
        .by('addressId', address.id)
        .filter((row) => row.nameKey === nameKey && row.name === address.launchName)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id)[0];
    // Candidates in precedence order: an external client's fixed name, the pool
    // holder, then any other address still holding the name (active or quarantined).
    const candidates: { lease: NonNullable<typeof lease>; fixed: boolean }[] = [];
    for (const address of externalNameHolders(snapshot.addresses.by('engine', ENGINE_EXTERNAL), nameKey)) {
      const row = named(address);
      if (row) candidates.push({ lease: row, fixed: true });
    }
    const slot = snapshot.table('agentNamePool').get(nameKey);
    const pooled = slot?.currentSessionId
      ? leases
          .by('sessionId', slot.currentSessionId)
          .filter((row) => row.nameKey === slot.nameKey)
          .sort((a, b) => b.id - a.id)[0]
      : undefined;
    if (pooled) candidates.push({ lease: pooled, fixed: false });
    for (const address of snapshot.addresses.all()) {
      if (address.engine === ENGINE_EXTERNAL || !address.launchName || agentNameKey(address.launchName) !== nameKey)
        continue;
      const row = named(address);
      if (row && !candidates.some((c) => c.lease.id === row.id) && stateOf(row).reserved)
        candidates.push({ lease: row, fixed: false });
    }
    // A stale holder on a host that cannot take part in messaging must not shadow
    // a reachable address with the same name.
    const reachable = (id: string) => {
      try {
        ownedAddress(snapshot, id, at);
        return true;
      } catch {
        return false;
      }
    };
    const chosen =
      candidates.find((c) => (c.fixed || stateOf(c.lease).reserved) && reachable(c.lease.addressId)) ??
      candidates[0];
    lease = chosen?.lease;
    fixed = !!chosen?.fixed;
  }
  if (!lease) throw new NotFoundError('No launch name assignment found', 'agent_name_not_found');
  const state = ownedNameLeaseState(lease, snapshot.sessions.get(lease.sessionId) ?? null, now);
  if (!uuid && !fixed && !state.reserved)
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

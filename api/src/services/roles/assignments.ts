/**
 * Role assignments: which agent address holds which pinned role version.
 *
 * An assignment hangs on the agent address because that is the identity a
 * resume keeps (a fresh launch gets a new address). It pins one version, so a
 * newer publish never changes a running session; only an explicit activation
 * with `replace` (or a `self_upgrade` of the same role) moves it.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, like, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import {
  agentRoleAssignments,
  agentRoleVersions,
  agentRoles,
  type AgentRole,
  type AgentRoleAssignment,
  type AgentRoleVersion,
  type AgentSession,
  type Host,
} from '../../db/schema.js';
import { ApiError, ConflictError } from '../../http/errors.js';
import { nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import { activationPayload, type RoleDb } from './content.js';
import { ROLE_ACTIVATION_KINDS, ROLE_REASON_MAX, normalizeRoleSlug, parseRoleManifest, readRolePolicy, roleUri } from './contract.js';

export interface RoleSessionCore {
  db: Database;
  authenticateBridge(sessionId: string, token: string): Promise<{ session: AgentSession; host: Host }>;
  assertEnabled(): Promise<void>;
}

const activateSchema = z
  .object({
    role: z.string().min(1).max(64),
    version: z.union([z.literal('latest'), z.number().int().positive()]).optional(),
    reason: z.string().trim().min(1).max(ROLE_REASON_MAX),
    replace: z.boolean().optional(),
    client_request_id: z.string().uuid(),
    activated_by: z.enum(ROLE_ACTIVATION_KINDS).optional(),
    peer_address: z.string().max(96).optional(),
    message_id: z.string().uuid().optional(),
  })
  .strict();

export interface ActiveRoleView {
  slug: string;
  display_name: string;
  /** What the session title shows: "(Name) (label) task". */
  label: string;
  version: number | null;
  sha: string;
  version_state: string;
  assignment_id: string;
  activated_at: string;
}

/** The active role of each address, for `agent_self` and `agent_list`. */
export async function activeRolesForAddresses(db: RoleDb, addressIds: string[]): Promise<Map<string, ActiveRoleView>> {
  const ids = [...new Set(addressIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.select().from(agentRoleAssignments).where(inArray(agentRoleAssignments.activeAddressId, ids));
  if (!rows.length) return new Map();
  const roles = await db.select().from(agentRoles).where(inArray(agentRoles.id, [...new Set(rows.map((row) => row.roleId))]));
  const versions = await db.select().from(agentRoleVersions).where(inArray(agentRoleVersions.id, [...new Set(rows.map((row) => row.versionId))]));
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const out = new Map<string, ActiveRoleView>();
  for (const row of rows) {
    const role = roleById.get(row.roleId);
    const version = versionById.get(row.versionId);
    if (!role || !version) continue;
    out.set(row.addressId, {
      slug: role.slug,
      display_name: role.displayName,
      label: roleLabel(role, version),
      version: version.version,
      sha: version.bundleSha256.slice(0, 12),
      version_state: version.state,
      assignment_id: row.id,
      activated_at: row.createdAt,
    });
  }
  return out;
}

/** The session-title label: the manifest's `label`, else the display name, without parentheses. */
export function roleLabel(role: AgentRole, version: AgentRoleVersion): string {
  let label: string | null = null;
  try {
    label = parseRoleManifest(role.slug, version.manifest).label;
  } catch {
    label = null;
  }
  return (label ?? role.displayName).replace(/[()]/g, '').trim().slice(0, 40) || role.slug;
}

/**
 * Every label this address has carried, so the session-title writer can strip
 * an old "(Label)" after a switch or release.
 */
export async function roleLabelsForAddress(db: RoleDb, addressId: string): Promise<string[]> {
  const rows = await db.select().from(agentRoleAssignments).where(eq(agentRoleAssignments.addressId, addressId)).orderBy(desc(agentRoleAssignments.createdAt)).limit(20);
  if (!rows.length) return [];
  const roles = await db.select().from(agentRoles).where(inArray(agentRoles.id, [...new Set(rows.map((row) => row.roleId))]));
  const versions = await db.select().from(agentRoleVersions).where(inArray(agentRoleVersions.id, [...new Set(rows.map((row) => row.versionId))]));
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const labels = rows.flatMap((row) => {
    const role = roleById.get(row.roleId);
    const version = versionById.get(row.versionId);
    return role && version ? [roleLabel(role, version)] : [];
  });
  return [...new Set(labels)];
}

/** Address ids currently holding `slug`, for the `agent_list` role filter. */
export async function addressesHoldingRole(db: RoleDb, slug: string): Promise<string[]> {
  const [role] = await db.select().from(agentRoles).where(eq(agentRoles.slug, slug)).limit(1);
  if (!role) return [];
  const rows = await db
    .select({ addressId: agentRoleAssignments.addressId })
    .from(agentRoleAssignments)
    .where(and(eq(agentRoleAssignments.roleId, role.id), eq(agentRoleAssignments.status, 'active')));
  return rows.map((row) => row.addressId);
}

/**
 * A `reset` binding means the transcript that was told "you are X" is gone, so
 * the role goes with it; a new assignment needs a new instruction.
 */
export async function endAssignmentOnContinuityReset(db: RoleDb, addressId: string): Promise<void> {
  const now = nowIso();
  await db
    .update(agentRoleAssignments)
    .set({ status: 'ended', activeAddressId: null, endedAt: now, endReason: 'continuity_reset', updatedAt: now })
    .where(eq(agentRoleAssignments.activeAddressId, addressId));
}

function assignmentView(row: AgentRoleAssignment) {
  return {
    id: row.id,
    status: row.status,
    activated_by: row.activatedBy,
    reason: row.reason,
    activated_at: row.createdAt,
    previous_assignment_id: row.previousAssignmentId,
    ended_at: row.endedAt,
    end_reason: row.endReason,
  };
}

export class RoleAssignments {
  constructor(private readonly core: RoleSessionCore) {}

  private async identity(sessionId: string, token: string) {
    const { session } = await this.core.authenticateBridge(sessionId, token);
    if (!session.agentBusAddressId)
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    await this.core.assertEnabled();
    return { session, addressId: session.agentBusAddressId };
  }

  /** Close names first, so "Design-Agent" can suggest `design`. */
  private async candidates(db: RoleDb, query: string) {
    const token = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((part) => part.length >= 3)[0];
    const rows = await db
      .select({ slug: agentRoles.slug, display_name: agentRoles.displayName, summary: agentRoles.summary })
      .from(agentRoles)
      .where(and(eq(agentRoles.status, 'active'), token ? or(like(agentRoles.slug, `%${token}%`), like(agentRoles.displayName, `%${token}%`)) : undefined))
      .limit(10);
    return rows;
  }

  private async resolveVersion(db: RoleDb, role: AgentRole, requested: 'latest' | number | undefined): Promise<AgentRoleVersion> {
    if (requested === undefined || requested === 'latest') {
      if (!role.currentVersionId)
        throw new ApiError(`Role ${role.slug} has no published version`, { status: 409, code: 'role_version_not_found' });
      const [version] = await db.select().from(agentRoleVersions).where(eq(agentRoleVersions.id, role.currentVersionId)).limit(1);
      if (!version) throw new ApiError(`Role ${role.slug} has no published version`, { status: 409, code: 'role_version_not_found' });
      return version;
    }
    const [version] = await db
      .select()
      .from(agentRoleVersions)
      .where(and(eq(agentRoleVersions.roleId, role.id), eq(agentRoleVersions.version, requested)))
      .limit(1);
    if (!version || version.state === 'draft')
      throw new ApiError(`Role ${role.slug} has no version ${requested}`, { status: 404, code: 'role_version_not_found' });
    if (version.state === 'withdrawn')
      throw new ApiError(`Role ${role.slug} version ${requested} was withdrawn`, { status: 409, code: 'role_version_withdrawn' });
    return version;
  }

  private async newerVersion(db: RoleDb, role: AgentRole, pinned: AgentRoleVersion): Promise<number | null> {
    if (!role.currentVersionId || role.currentVersionId === pinned.id) return null;
    const [current] = await db.select().from(agentRoleVersions).where(eq(agentRoleVersions.id, role.currentVersionId)).limit(1);
    return current?.version && pinned.version && current.version > pinned.version ? current.version : null;
  }

  private async payload(db: RoleDb, row: AgentRoleAssignment, includeCore: boolean, created?: boolean) {
    const [role] = await db.select().from(agentRoles).where(eq(agentRoles.id, row.roleId)).limit(1);
    const [version] = await db.select().from(agentRoleVersions).where(eq(agentRoleVersions.id, row.versionId)).limit(1);
    if (!role || !version) throw new ConflictError('Assigned role version is missing', 'role_payload_invalid');
    const policy = readRolePolicy(role.policy);
    return {
      ...(created === undefined ? {} : { created }),
      assignment: assignmentView(row),
      role: {
        slug: role.slug,
        display_name: role.displayName,
        summary: role.summary,
        status: role.status,
        version: version.version,
        version_state: version.state,
        sha: version.bundleSha256,
        uri: roleUri(role.slug, version.version),
        holder_upgrade: policy.holder_upgrade,
      },
      newer_version: await this.newerVersion(db, role, version),
      ...(includeCore ? await activationPayload(db, role, version) : {}),
    };
  }

  async activate(sessionId: string, token: string, body: unknown) {
    const input = activateSchema.parse(body ?? {});
    const { session, addressId } = await this.identity(sessionId, token);
    const kind = input.activated_by ?? 'operator_prompt';
    const result = await this.core.db.transaction(async (tx) => {
      const [repeat] = await tx
        .select()
        .from(agentRoleAssignments)
        .where(and(eq(agentRoleAssignments.addressId, addressId), eq(agentRoleAssignments.clientRequestId, input.client_request_id)))
        .limit(1);
      if (repeat) return this.payload(tx, repeat, true, false);

      const slug = normalizeRoleSlug(input.role);
      const [role] = await tx.select().from(agentRoles).where(eq(agentRoles.slug, slug)).limit(1).for('update');
      if (!role)
        throw new ApiError(`No role named ${slug}`, { status: 404, code: 'role_not_found', extra: { candidates: await this.candidates(tx, input.role) } });
      if (role.status !== 'active') throw new ApiError(`Role ${slug} is retired`, { status: 409, code: 'role_retired' });
      const version = await this.resolveVersion(tx, role, input.version);

      const [existing] = await tx
        .select()
        .from(agentRoleAssignments)
        .where(eq(agentRoleAssignments.activeAddressId, addressId))
        .limit(1)
        .for('update');
      let endReason: 'switched' | 'upgraded' | null = null;
      if (existing) {
        if (existing.roleId === role.id && existing.versionId === version.id) return this.payload(tx, existing, true, false);
        const sameRole = existing.roleId === role.id;
        // A peer may hand a role to an agent without one, never take one away.
        if (kind === 'peer' || (kind === 'self_upgrade' && !sameRole) || (!input.replace && kind !== 'self_upgrade')) {
          const [held] = await tx.select().from(agentRoles).where(eq(agentRoles.id, existing.roleId)).limit(1);
          throw new ApiError(`This agent already holds role ${held?.slug ?? existing.roleId}`, {
            status: 409,
            code: 'role_already_active',
            extra: { active_role: held?.slug ?? null, hint: 'only the principal who assigned the role may change it; pass replace:true on their explicit instruction' },
          });
        }
        if (kind === 'self_upgrade') {
          if (readRolePolicy(role.policy).holder_upgrade === 'manual')
            throw new ApiError(`Role ${slug} upgrades only on the principal's instruction`, { status: 409, code: 'role_upgrade_manual' });
          const [pinned] = await tx.select().from(agentRoleVersions).where(eq(agentRoleVersions.id, existing.versionId)).limit(1);
          if ((version.version ?? 0) <= (pinned?.version ?? 0))
            throw new ApiError('self_upgrade only moves to a newer version', { status: 409, code: 'role_upgrade_not_newer' });
        }
        endReason = sameRole ? 'upgraded' : 'switched';
      } else if (kind === 'self_upgrade') {
        throw new ApiError('self_upgrade needs an active assignment of the same role', { status: 409, code: 'no_active_role' });
      }

      const now = nowIso();
      if (existing) {
        await tx
          .update(agentRoleAssignments)
          .set({ status: 'ended', activeAddressId: null, endedAt: now, endReason, updatedAt: now })
          .where(eq(agentRoleAssignments.id, existing.id));
      }
      const id = randomUUID();
      await tx.insert(agentRoleAssignments).values({
        id,
        addressId,
        activeAddressId: addressId,
        roleId: role.id,
        versionId: version.id,
        status: 'active',
        bindingGeneration: session.bindingGeneration,
        activatedBy: {
          kind,
          session_id: session.id,
          ...(input.peer_address ? { peer_address: input.peer_address } : {}),
          ...(input.message_id ? { message_id: input.message_id } : {}),
        },
        reason: input.reason,
        clientRequestId: input.client_request_id,
        previousAssignmentId: existing?.id ?? null,
        createdAt: now,
        updatedAt: now,
      });
      const [row] = await tx.select().from(agentRoleAssignments).where(eq(agentRoleAssignments.id, id)).limit(1);
      return this.payload(tx, row!, true, true);
    });
    wsPublisher.publish('agent_roles.assignment.changed', { address_id: addressId, role: result.role.slug, version: result.role.version });
    return result;
  }

  async current(sessionId: string, token: string, body: unknown) {
    const input = z.object({ include_core: z.boolean().optional() }).strict().parse(body ?? {});
    const { addressId } = await this.identity(sessionId, token);
    const [row] = await this.core.db.select().from(agentRoleAssignments).where(eq(agentRoleAssignments.activeAddressId, addressId)).limit(1);
    if (!row) {
      const [last] = await this.core.db
        .select()
        .from(agentRoleAssignments)
        .where(and(eq(agentRoleAssignments.addressId, addressId), isNull(agentRoleAssignments.activeAddressId)))
        .orderBy(desc(agentRoleAssignments.updatedAt))
        .limit(1);
      return { active: null, last_ended: last ? assignmentView(last) : null };
    }
    return { active: true, ...(await this.payload(this.core.db, row, input.include_core === true)) };
  }

  async release(sessionId: string, token: string, body: unknown) {
    const input = z.object({ reason: z.string().trim().min(1).max(ROLE_REASON_MAX) }).strict().parse(body ?? {});
    const { addressId } = await this.identity(sessionId, token);
    const now = nowIso();
    const ended = await this.core.db.transaction(async (tx) => {
      const [row] = await tx.select().from(agentRoleAssignments).where(eq(agentRoleAssignments.activeAddressId, addressId)).limit(1).for('update');
      if (!row) throw new ApiError('This agent holds no role', { status: 409, code: 'no_active_role' });
      await tx
        .update(agentRoleAssignments)
        .set({ status: 'ended', activeAddressId: null, endedAt: now, endReason: 'released', reason: `${row.reason}\n[released] ${input.reason}`.slice(0, 65535), updatedAt: now })
        .where(eq(agentRoleAssignments.id, row.id));
      return row.id;
    });
    wsPublisher.publish('agent_roles.assignment.changed', { address_id: addressId, role: null });
    return { ended_assignment_id: ended };
  }

  /** Active holders of a role, newest first. */
  async holders(db: RoleDb, roleId: string): Promise<AgentRoleAssignment[]> {
    return db
      .select()
      .from(agentRoleAssignments)
      .where(and(eq(agentRoleAssignments.roleId, roleId), eq(agentRoleAssignments.status, 'active')))
      .orderBy(desc(agentRoleAssignments.createdAt));
  }

  /** The active assignment of one address, or null. */
  async activeFor(db: RoleDb, addressId: string): Promise<AgentRoleAssignment | null> {
    const [row] = await db.select().from(agentRoleAssignments).where(eq(agentRoleAssignments.activeAddressId, addressId)).limit(1);
    return row ?? null;
  }
}

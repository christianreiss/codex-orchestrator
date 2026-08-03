/**
 * Named fleet security postures and their per-host assignment.
 *
 * A profile is a level vector, not a document. The canonical prose stays one
 * fleet document so a wording fix reaches every profile at once; only posture
 * varies per host. That split is why assigning a profile cannot be expressed as
 * `hosts.agents_document_id_override` — that pin selects *which prose* a host
 * gets, which is an orthogonal axis and stays orthogonal.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentPolicyProfileAssignments, agentPolicyProfiles } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import {
  DEFAULT_SECURITY_LEVELS,
  normalizeSecurityLevels,
  securityLevelEnforcement,
  type SecurityLevels,
} from './agent-security-levels.js';

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;

export interface AgentPolicyProfileView {
  id: number;
  name: string;
  description: string | null;
  levels: SecurityLevels;
  is_default: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
  /** Host ids currently served at this profile. */
  host_ids: number[];
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ValidationError('name is required', { param: 'name' });
  }
  const name = raw.trim();
  if (name === '') throw new ValidationError('name is required', { param: 'name' });
  if (name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`, { param: 'name' });
  }
  return name;
}

function normalizeDescription(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new ValidationError('description must be a string', { param: 'description' });
  }
  const description = raw.trim();
  if (description === '') return null;
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`, {
      param: 'description',
    });
  }
  return description;
}

export class AgentPolicyProfilesService {
  constructor(private readonly db: Database) {}

  private async assignments(): Promise<Array<{ hostId: number; profileId: number }>> {
    const rows = await this.db.select().from(agentPolicyProfileAssignments);
    return rows.map((row) => ({ hostId: Number(row.hostId), profileId: Number(row.profileId) }));
  }

  private toView(
    row: typeof agentPolicyProfiles.$inferSelect,
    assigned: Array<{ hostId: number; profileId: number }>,
  ): AgentPolicyProfileView {
    return {
      id: Number(row.id),
      name: row.name,
      description: row.description ?? null,
      // Normalized on read so a row written before an axis existed still
      // resolves to a complete vector instead of a partial one.
      levels: normalizeSecurityLevels(row.levels),
      is_default: Number(row.isDefault) === 1,
      revision: Number(row.revision),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      host_ids: assigned.filter((a) => a.profileId === Number(row.id)).map((a) => a.hostId),
    };
  }

  async list(): Promise<AgentPolicyProfileView[]> {
    const [rows, assigned] = await Promise.all([
      this.db.select().from(agentPolicyProfiles),
      this.assignments(),
    ]);
    return rows
      .map((row) => this.toView(row, assigned))
      .sort((a, b) => (a.is_default === b.is_default ? a.name.localeCompare(b.name) : a.is_default ? -1 : 1));
  }

  private async requireRow(id: number): Promise<typeof agentPolicyProfiles.$inferSelect> {
    const rows = await this.db
      .select()
      .from(agentPolicyProfiles)
      .where(eq(agentPolicyProfiles.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('Policy profile not found');
    return row;
  }

  async create(input: { name?: unknown; description?: unknown; levels?: unknown }): Promise<AgentPolicyProfileView> {
    const name = normalizeName(input.name);
    const description = normalizeDescription(input.description);
    const levels = normalizeSecurityLevels(input.levels);
    const ts = nowIso();

    const existing = await this.db
      .select()
      .from(agentPolicyProfiles)
      .where(eq(agentPolicyProfiles.name, name))
      .limit(1);
    if (existing[0]) {
      throw new ValidationError(`a policy profile named ${name} already exists`, { param: 'name' });
    }

    await this.db.insert(agentPolicyProfiles).values({
      name,
      description,
      levels,
      isDefault: 0,
      revision: 1,
      createdAt: ts,
      updatedAt: ts,
    });
    wsPublisher.publish('agents.stored', { profile: name });
    const rows = await this.db
      .select()
      .from(agentPolicyProfiles)
      .where(eq(agentPolicyProfiles.name, name))
      .limit(1);
    return this.toView(rows[0]!, await this.assignments());
  }

  /**
   * Levels and prose are versioned separately, so `revision` is the profile's
   * own audit counter — reverting the document to an older version restores
   * old wording, never an old posture.
   */
  async update(
    id: number,
    input: { name?: unknown; description?: unknown; levels?: unknown },
  ): Promise<AgentPolicyProfileView> {
    const row = await this.requireRow(id);
    const patch: Record<string, unknown> = { updatedAt: nowIso(), revision: Number(row.revision) + 1 };
    if (input.name !== undefined) patch['name'] = normalizeName(input.name);
    if (input.description !== undefined) patch['description'] = normalizeDescription(input.description);
    if (input.levels !== undefined) patch['levels'] = normalizeSecurityLevels(input.levels);

    await this.db.update(agentPolicyProfiles).set(patch).where(eq(agentPolicyProfiles.id, id));
    wsPublisher.publish('agents.stored', { profile_id: id });
    return this.toView(await this.requireRow(id), await this.assignments());
  }

  async remove(id: number): Promise<{ deleted_id: number }> {
    const row = await this.requireRow(id);
    if (Number(row.isDefault) === 1) {
      // Without a default there is no posture to fall back to, and every
      // unassigned host would silently change behaviour.
      throw new ValidationError('the fleet default profile cannot be deleted', { param: 'id' });
    }
    await this.db.delete(agentPolicyProfileAssignments).where(eq(agentPolicyProfileAssignments.profileId, id));
    await this.db.delete(agentPolicyProfiles).where(eq(agentPolicyProfiles.id, id));
    wsPublisher.publish('agents.stored', { deleted_profile_id: id });
    return { deleted_id: id };
  }

  async setDefault(id: number): Promise<AgentPolicyProfileView> {
    await this.requireRow(id);
    const rows = await this.db.select().from(agentPolicyProfiles);
    for (const row of rows) {
      const shouldBeDefault = Number(row.id) === id ? 1 : 0;
      if (Number(row.isDefault) === shouldBeDefault) continue;
      await this.db
        .update(agentPolicyProfiles)
        .set({ isDefault: shouldBeDefault, updatedAt: nowIso() })
        .where(eq(agentPolicyProfiles.id, Number(row.id)));
    }
    wsPublisher.publish('agents.stored', { default_profile_id: id });
    return this.toView(await this.requireRow(id), await this.assignments());
  }

  /** Assign a host to a profile, or clear the assignment back to the fleet default. */
  async assign(hostId: number, profileId: number | null): Promise<{ host_id: number; profile_id: number | null }> {
    const ts = nowIso();
    if (profileId === null) {
      await this.db
        .delete(agentPolicyProfileAssignments)
        .where(eq(agentPolicyProfileAssignments.hostId, hostId));
      wsPublisher.publish('agents.stored', { host_id: hostId, profile_id: null });
      return { host_id: hostId, profile_id: null };
    }
    await this.requireRow(profileId);
    const existing = await this.db
      .select()
      .from(agentPolicyProfileAssignments)
      .where(eq(agentPolicyProfileAssignments.hostId, hostId))
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(agentPolicyProfileAssignments)
        .set({ profileId, updatedAt: ts })
        .where(eq(agentPolicyProfileAssignments.hostId, hostId));
    } else {
      await this.db
        .insert(agentPolicyProfileAssignments)
        .values({ hostId, profileId, createdAt: ts, updatedAt: ts });
    }
    wsPublisher.publish('agents.stored', { host_id: hostId, profile_id: profileId });
    return { host_id: hostId, profile_id: profileId };
  }

  /**
   * The posture a host is served at: its assigned profile, else the fleet
   * default, else the built-in Standard vector.
   *
   * Falls back rather than throwing on every failure path. A policy document is
   * served on the launch path, so a missing row or an unreadable table must
   * degrade to today's posture, never to no document at all.
   */
  async resolveForHost(hostId: number): Promise<SecurityLevels> {
    try {
      const assigned = await this.db
        .select()
        .from(agentPolicyProfileAssignments)
        .where(eq(agentPolicyProfileAssignments.hostId, hostId))
        .limit(1);
      const profileId = assigned[0] ? Number(assigned[0].profileId) : null;
      if (profileId !== null) {
        const rows = await this.db
          .select()
          .from(agentPolicyProfiles)
          .where(eq(agentPolicyProfiles.id, profileId))
          .limit(1);
        if (rows[0]) return normalizeSecurityLevels(rows[0].levels);
      }
      const defaults = await this.db
        .select()
        .from(agentPolicyProfiles)
        .where(eq(agentPolicyProfiles.isDefault, 1))
        .limit(1);
      if (defaults[0]) return normalizeSecurityLevels(defaults[0].levels);
    } catch {
      // Fall through to the built-in default.
    }
    return { ...DEFAULT_SECURITY_LEVELS };
  }

  /** What the resolved posture implies for engine config, for the console's drift panel. */
  async enforcementForHost(hostId: number): Promise<ReturnType<typeof securityLevelEnforcement>> {
    return securityLevelEnforcement(await this.resolveForHost(hostId));
  }
}

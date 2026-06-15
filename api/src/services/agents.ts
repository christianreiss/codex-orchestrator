/**
 * Agents (AGENTS.md / CLAUDE.md) document store. Multi-version: every store
 * appends a new row to `agents_documents`; the served version is selected by
 * `agents_document_state.active_document_id`. State is per-engine (codex
 * uses state row id=1, claude uses id=2 to mirror the legacy convention).
 *
 * Modes:
 *   - "latest"  → serve the newest row matching the engine (active_document_id ignored)
 *   - "locked"  → serve the row pinned by active_document_id
 *
 * Revert: store an exact copy of an older version as a new row, set state
 * back to "latest", emit `agents.stored`.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentsDocuments, agentsDocumentState } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { ENGINE_CODEX, type Engine, parseEngine } from '../util/engine.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';

export const AGENTS_MODE_LATEST = 'latest';
export const AGENTS_MODE_LOCKED = 'locked';
const MAX_BACKUP_LIMIT = 200;

function stateRowId(engine: Engine): number {
  return engine === 'claude' ? 2 : 1;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface AgentsVersionPayload {
  id: number;
  sha256: string;
  updated_at: string;
  created_at: string;
  size_bytes: number;
  is_latest: boolean;
  is_active: boolean;
  is_served: boolean;
}

export interface AgentsAdminView {
  status: 'ok' | 'missing';
  mode: string;
  engine: Engine;
  active_id: number | null;
  served_id: number | null;
  latest_id: number | null;
  backup_limit: number | null;
  sha256?: string;
  updated_at?: string | null;
  size_bytes?: number;
  content?: string;
  versions: AgentsVersionPayload[];
}

export interface AgentsStoreResult {
  status: 'created' | 'unchanged';
  version_id: number;
  sha256: string;
  updated_at: string;
  size_bytes: number;
  pruned_count: number;
}

function assertSha(sha: unknown, allowNull = true): void {
  if (sha === null || sha === undefined) {
    if (allowNull) return;
    throw new ValidationError('sha256 is required', { param: 'sha256' });
  }
  if (typeof sha !== 'string') {
    throw new ValidationError('sha256 must be a string', { param: 'sha256' });
  }
  const v = sha.trim().toLowerCase();
  if (v === '' && allowNull) return;
  if (!/^[a-f0-9]{64}$/.test(v)) {
    throw new ValidationError('sha256 must be 64 hex characters', { param: 'sha256' });
  }
}

export class AgentsService {
  constructor(
    private readonly db: Database,
    private readonly backupLimitGetter: () => Promise<number | null> = async () => null,
  ) {}

  /**
   * Locate the row currently served for the given engine, honoring the
   * locked mode and falling back to latest-by-engine, then latest-any.
   */
  private async resolveServed(engine: Engine = ENGINE_CODEX): Promise<typeof agentsDocuments.$inferSelect | null> {
    const state = await this.readState(engine);
    if (state.mode === AGENTS_MODE_LOCKED && state.activeDocumentId !== null) {
      const rows = await this.db
        .select()
        .from(agentsDocuments)
        .where(eq(agentsDocuments.id, state.activeDocumentId))
        .limit(1);
      if (rows[0]) return rows[0];
      // Fallback: state pointed at a deleted row; reset to latest.
      await this.writeState(AGENTS_MODE_LATEST, null, engine);
    }
    const latestEngine = await this.db
      .select()
      .from(agentsDocuments)
      .where(eq(agentsDocuments.engine, engine))
      .orderBy(desc(agentsDocuments.id))
      .limit(1);
    if (latestEngine[0]) return latestEngine[0];
    const latestAny = await this.db
      .select()
      .from(agentsDocuments)
      .orderBy(desc(agentsDocuments.id))
      .limit(1);
    return latestAny[0] ?? null;
  }

  private async readState(engine: Engine = ENGINE_CODEX): Promise<{
    id: number;
    mode: string;
    activeDocumentId: number | null;
    engine: string;
  }> {
    const id = stateRowId(engine);
    const rows = await this.db
      .select()
      .from(agentsDocumentState)
      .where(eq(agentsDocumentState.id, id))
      .limit(1);
    if (rows[0]) {
      return {
        id: rows[0].id,
        mode: rows[0].mode,
        activeDocumentId: rows[0].activeDocumentId,
        engine: rows[0].engine,
      };
    }
    // Row missing: insert default.
    const nowTs = nowIso();
    await this.db.insert(agentsDocumentState).values({
      id,
      mode: AGENTS_MODE_LATEST,
      activeDocumentId: null,
      engine,
      createdAt: nowTs,
      updatedAt: nowTs,
    });
    return { id, mode: AGENTS_MODE_LATEST, activeDocumentId: null, engine };
  }

  private async writeState(mode: string, activeId: number | null, engine: Engine = ENGINE_CODEX): Promise<void> {
    const id = stateRowId(engine);
    await this.readState(engine); // ensure exists
    await this.db
      .update(agentsDocumentState)
      .set({ mode, activeDocumentId: activeId, updatedAt: nowIso() })
      .where(eq(agentsDocumentState.id, id));
  }

  private async listVersions(limit = 50): Promise<typeof agentsDocuments.$inferSelect[]> {
    return await this.db
      .select()
      .from(agentsDocuments)
      .orderBy(desc(agentsDocuments.id))
      .limit(Math.max(1, Math.min(limit, 200)));
  }

  async adminFetch(engine: Engine = ENGINE_CODEX): Promise<AgentsAdminView> {
    const state = await this.readState(engine);
    const latestRows = await this.db
      .select()
      .from(agentsDocuments)
      .orderBy(desc(agentsDocuments.id))
      .limit(1);
    const latest = latestRows[0] ?? null;
    const served = await this.resolveServed(engine);
    const versions = await this.listVersions(50);
    const backupLimit = await this.backupLimitGetter();

    const versionPayloads = versions.map((v): AgentsVersionPayload => ({
      id: v.id,
      sha256: v.sha256 ?? sha256Hex(v.body),
      updated_at: v.updatedAt,
      created_at: v.createdAt,
      size_bytes: Buffer.byteLength(v.body, 'utf8'),
      is_latest: latest !== null && latest.id === v.id,
      is_active: state.activeDocumentId !== null && state.activeDocumentId === v.id,
      is_served: served !== null && served.id === v.id,
    }));

    if (served === null) {
      return {
        status: 'missing',
        mode: state.mode,
        engine,
        active_id: state.activeDocumentId,
        served_id: null,
        latest_id: latest ? latest.id : null,
        backup_limit: backupLimit,
        versions: versionPayloads,
      };
    }

    return {
      status: 'ok',
      mode: state.mode,
      engine,
      active_id: state.activeDocumentId,
      served_id: served.id,
      latest_id: latest ? latest.id : null,
      backup_limit: backupLimit,
      sha256: served.sha256 ?? sha256Hex(served.body),
      updated_at: served.updatedAt,
      size_bytes: Buffer.byteLength(served.body, 'utf8'),
      content: served.body,
      versions: versionPayloads,
    };
  }

  async adminFetchVersion(versionId: number, engine: Engine = ENGINE_CODEX): Promise<AgentsVersionPayload & { content: string }> {
    if (!versionId || versionId <= 0) {
      throw new ValidationError('version_id is required', { param: 'version_id' });
    }
    const rows = await this.db
      .select()
      .from(agentsDocuments)
      .where(eq(agentsDocuments.id, versionId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ValidationError('version_id not found', { param: 'version_id' });

    const state = await this.readState(engine);
    const latestRows = await this.db
      .select()
      .from(agentsDocuments)
      .orderBy(desc(agentsDocuments.id))
      .limit(1);
    const latest = latestRows[0] ?? null;
    const served = await this.resolveServed(engine);

    return {
      id: row.id,
      sha256: row.sha256 ?? sha256Hex(row.body),
      updated_at: row.updatedAt,
      created_at: row.createdAt,
      size_bytes: Buffer.byteLength(row.body, 'utf8'),
      is_latest: latest !== null && latest.id === row.id,
      is_active: state.activeDocumentId !== null && state.activeDocumentId === row.id,
      is_served: served !== null && served.id === row.id,
      content: row.body,
    };
  }

  async store(content: unknown, providedSha: unknown, sourceHostId: number | null = null, rawEngine: unknown = ENGINE_CODEX): Promise<AgentsStoreResult> {
    if (typeof content !== 'string') {
      throw new ValidationError('content is required', { param: 'content' });
    }
    assertSha(providedSha, true);
    const engine: Engine = parseEngine(rawEngine, ENGINE_CODEX);
    const body = content;
    const sha = sha256Hex(body);
    if (typeof providedSha === 'string' && providedSha.trim() !== '' && providedSha.trim().toLowerCase() !== sha) {
      throw new ValidationError('sha256 does not match AGENTS.md contents', { param: 'sha256' });
    }

    // Dedup: if the most recent row for this engine is identical content, treat as unchanged.
    const latest = await this.db
      .select()
      .from(agentsDocuments)
      .where(eq(agentsDocuments.engine, engine))
      .orderBy(desc(agentsDocuments.id))
      .limit(1);
    const existing = latest[0];
    if (existing && existing.sha256 === sha) {
      return {
        status: 'unchanged',
        version_id: existing.id,
        sha256: existing.sha256,
        updated_at: existing.updatedAt,
        size_bytes: Buffer.byteLength(existing.body, 'utf8'),
        pruned_count: 0,
      };
    }

    const nowTs = nowIso();
    const inserted = await this.db.insert(agentsDocuments).values({
      sha256: sha,
      body,
      sourceHostId,
      engine,
      createdAt: nowTs,
      updatedAt: nowTs,
    }).$returningId();
    const newId = inserted[0]?.id ?? null;

    // Prune historical versions if backup limit configured.
    let prunedCount = 0;
    const limit = await this.backupLimitGetter();
    if (limit !== null && limit > 0) {
      prunedCount = await this.pruneHistorical(limit, newId);
    }

    wsPublisher.publish('agents.stored', { engine, version_id: newId, sha256: sha });

    return {
      status: 'created',
      version_id: newId ?? 0,
      sha256: sha,
      updated_at: nowTs,
      size_bytes: Buffer.byteLength(body, 'utf8'),
      pruned_count: prunedCount,
    };
  }

  async setServeMode(rawMode: unknown, versionId: number | null, rawEngine: unknown = ENGINE_CODEX): Promise<AgentsAdminView> {
    const mode = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : '';
    if (mode !== AGENTS_MODE_LATEST && mode !== AGENTS_MODE_LOCKED) {
      throw new ValidationError('mode must be latest or locked', { param: 'mode' });
    }
    const engine: Engine = parseEngine(rawEngine, ENGINE_CODEX);
    if (mode === AGENTS_MODE_LATEST) {
      await this.writeState(AGENTS_MODE_LATEST, null, engine);
      return await this.adminFetch(engine);
    }
    if (versionId === null || versionId <= 0) {
      throw new ValidationError('version_id is required to lock', { param: 'version_id' });
    }
    const target = await this.db
      .select()
      .from(agentsDocuments)
      .where(eq(agentsDocuments.id, versionId))
      .limit(1);
    if (!target[0]) {
      throw new ValidationError('version_id not found', { param: 'version_id' });
    }
    await this.writeState(AGENTS_MODE_LOCKED, versionId, engine);
    wsPublisher.publish('agents.stored', { engine, version_id: versionId, mode: 'locked' });
    return await this.adminFetch(engine);
  }

  async revertVersion(versionId: number, rawEngine: unknown = ENGINE_CODEX): Promise<AgentsAdminView> {
    if (!versionId || versionId <= 0) {
      throw new ValidationError('version_id is required', { param: 'version_id' });
    }
    const engine: Engine = parseEngine(rawEngine, ENGINE_CODEX);
    const rows = await this.db
      .select()
      .from(agentsDocuments)
      .where(eq(agentsDocuments.id, versionId))
      .limit(1);
    const source = rows[0];
    if (!source) throw new ValidationError('version_id not found', { param: 'version_id' });

    const body = source.body;
    const sha = source.sha256 ?? sha256Hex(body);
    const nowTs = nowIso();
    const inserted = await this.db.insert(agentsDocuments).values({
      sha256: sha,
      body,
      sourceHostId: null,
      engine,
      createdAt: nowTs,
      updatedAt: nowTs,
    }).$returningId();
    const newId = inserted[0]?.id ?? null;
    await this.writeState(AGENTS_MODE_LATEST, null, engine);
    wsPublisher.publish('agents.stored', { engine, version_id: newId, sha256: sha, reverted_from: versionId });
    return await this.adminFetch(engine);
  }

  async updateBackupRetention(rawLimit: unknown, setter: (value: number | null) => Promise<void>): Promise<{ backup_limit: number | null; pruned_count: number }> {
    const limit = this.normalizeBackupLimitInput(rawLimit);
    await setter(limit);
    let prunedCount = 0;
    if (limit !== null && limit > 0) {
      prunedCount = await this.pruneHistorical(limit, null);
    }
    return { backup_limit: limit, pruned_count: prunedCount };
  }

  private normalizeBackupLimitInput(raw: unknown): number | null {
    if (raw === null || raw === undefined || raw === '') return null;
    const asNum = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(asNum) || !Number.isInteger(asNum)) {
      throw new ValidationError('backup_limit must be an integer between 0 and 200', { param: 'backup_limit' });
    }
    if (asNum < 0 || asNum > MAX_BACKUP_LIMIT) {
      throw new ValidationError('backup_limit must be between 0 and 200', { param: 'backup_limit' });
    }
    return asNum === 0 ? null : asNum;
  }

  async deleteVersion(versionId: number, rawEngine: unknown = ENGINE_CODEX): Promise<AgentsAdminView> {
    if (!versionId || versionId <= 0) {
      throw new ValidationError('version_id is required', { param: 'version_id' });
    }
    const engine: Engine = parseEngine(rawEngine, ENGINE_CODEX);
    const served = await this.resolveServed(engine);
    if (served !== null && served.id === versionId) {
      throw new ValidationError('cannot delete the served version', { param: 'version_id' });
    }
    const rows = await this.db
      .select()
      .from(agentsDocuments)
      .where(eq(agentsDocuments.id, versionId))
      .limit(1);
    if (!rows[0]) throw new NotFoundError('version_id not found', 'version_not_found');
    await this.db.delete(agentsDocuments).where(eq(agentsDocuments.id, versionId));
    wsPublisher.publish('agents.stored', { engine, deleted_version_id: versionId });
    return await this.adminFetch(engine);
  }

  /**
   * Prune the oldest rows so that no more than `limit` historical (non-served,
   * non-latest) rows survive. Returns the number of rows deleted.
   */
  private async pruneHistorical(limit: number, protectId: number | null): Promise<number> {
    const all = await this.db
      .select({ id: agentsDocuments.id })
      .from(agentsDocuments)
      .orderBy(desc(agentsDocuments.id));
    const protectedIds = new Set<number>();
    if (protectId !== null) protectedIds.add(protectId);
    const eligible = all.filter((r) => !protectedIds.has(r.id));
    if (eligible.length <= limit) return 0;
    const toDelete = eligible.slice(limit).map((r) => r.id);
    let count = 0;
    for (const id of toDelete) {
      await this.db.delete(agentsDocuments).where(and(eq(agentsDocuments.id, id)));
      count += 1;
    }
    return count;
  }
}

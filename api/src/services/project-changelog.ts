/**
 * Per-project changelog: agent-written "what changed and why" entries,
 * optionally tied to a board card.
 *
 * - Hosts may update/delete only entries their own host wrote; the operator
 *   (admin routes) may change everything.
 * - Every mutation writes a `coord_project_events` row (entity_type
 *   `changelog`) carrying the full entry state — a delete carries the state it
 *   removed — so the event feed is the edit history; no revision table.
 * - Owner runtime: rows are owned like notes (body as private core content);
 *   search scores the owner view. Legacy: SQL with FULLTEXT and a degraded
 *   substring fallback when the index is missing.
 */
import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { coordProjectCards, coordProjectChangelog, coordProjects } from '../db/schema.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { isMissingFulltextIndex } from '../util/mysql-fulltext.js';
import { ownerRuntimeFor, mutateOwnerState, type OwnerMutationContext } from '../control-plane/state/runtime.js';
import { stageUpdate, stageDelete } from '../control-plane/state/rows.js';
import { stageProjectEvent } from '../control-plane/state/projects.js';
import type { Json } from '../control-plane/commands.js';
import { persistAuditLog } from './audit-log.js';
import { parseTags } from './memory-tags.js';
import { searchTerms } from './runtime-knowledge.js';
import { SettingsService } from './settings.js';
import { ProjectsService } from './projects.js';

import { PROJECT_CHANGELOG_ENABLED_FLAG } from './project-changelog-flags.js';
export { PROJECT_CHANGELOG_ENABLED_FLAG, PROJECT_CHANGELOG_TOOL_PREFIX } from './project-changelog-flags.js';
export const CHANGELOG_KINDS = ['feature', 'fix', 'change', 'decision', 'ops', 'note'] as const;
export type ChangelogKind = (typeof CHANGELOG_KINDS)[number];
export const CHANGELOG_TITLE_MAX = 300;
export const CHANGELOG_BODY_MAX = 16 * 1024;
const PREVIEW_CHARS = 280;
const MAX_TAGS = 16;
const MAX_TAG_LENGTH = 64;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type ChangelogRow = typeof coordProjectChangelog.$inferSelect;

export interface ChangelogEntryView {
  id: number;
  project: string;
  card_id: string | null;
  kind: string;
  title: string;
  body: string;
  body_truncated?: boolean;
  tags: string[];
  author_host_id: number | null;
  created_at: string;
  updated_at: string;
  score?: number;
}

export interface ChangelogActor {
  hostId: number | null;
  /** Operator (admin UI) may edit entries written by any host. */
  operator?: boolean;
}

export interface ChangelogListOptions {
  cardId?: string | null;
  kind?: string | null;
  tag?: string | null;
  limit?: number | null;
  beforeId?: number | null;
  preview?: boolean;
}

export interface ChangelogSearchOptions extends ChangelogListOptions {
  query?: string | null;
  /** Restrict to one project; omitted searches every project. */
  slug?: string | null;
}

type Input = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function normalizeKind(raw: unknown, fallback: ChangelogKind | null): ChangelogKind {
  const value = str(raw).toLowerCase();
  if (value === '') {
    if (fallback) return fallback;
  }
  if ((CHANGELOG_KINDS as readonly string[]).includes(value)) return value as ChangelogKind;
  throw new ValidationError(`kind must be one of: ${CHANGELOG_KINDS.join(', ')}`, { param: 'kind' });
}

function normalizeTitle(raw: unknown): string {
  const title = str(raw);
  if (title === '') throw new ValidationError('title is required', { param: 'title' });
  if (title.length > CHANGELOG_TITLE_MAX)
    throw new ValidationError(`title exceeds ${CHANGELOG_TITLE_MAX} characters`, { param: 'title' });
  return title;
}

function normalizeBody(raw: unknown): string {
  if (raw !== undefined && raw !== null && typeof raw !== 'string')
    throw new ValidationError('body must be a string', { param: 'body' });
  const body = typeof raw === 'string' ? raw.trim() : '';
  if (Buffer.byteLength(body, 'utf8') > CHANGELOG_BODY_MAX)
    throw new ValidationError(`body exceeds ${CHANGELOG_BODY_MAX} bytes`, { param: 'body' });
  return body;
}

function normalizeTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const list = typeof raw === 'string' ? raw.split(',') : raw;
  if (!Array.isArray(list)) throw new ValidationError('tags must be an array of strings', { param: 'tags' });
  const out = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') throw new ValidationError('tags must be an array of strings', { param: 'tags' });
    const tag = item.trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH)
      throw new ValidationError(`tag exceeds ${MAX_TAG_LENGTH} characters`, { param: 'tags' });
    out.add(tag);
  }
  if (out.size > MAX_TAGS) throw new ValidationError(`at most ${MAX_TAGS} tags`, { param: 'tags' });
  return [...out].sort();
}

function normalizeCardId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ValidationError('card_id must be a string', { param: 'card_id' });
  const value = raw.trim();
  if (value === '') return null;
  if (value.length > 64) throw new ValidationError('card_id is too long', { param: 'card_id' });
  return value;
}

/** Full entry state for event payloads: replaying events rebuilds every version. */
function eventState(row: Pick<ChangelogRow, 'id' | 'cardId' | 'kind' | 'title' | 'body' | 'tags'>): Record<string, unknown> {
  return {
    id: row.id,
    card_id: row.cardId ?? null,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseTags(row.tags),
  };
}

export class ProjectChangelogService {
  constructor(
    private readonly db: Database,
    private readonly projects: ProjectsService = new ProjectsService(db),
  ) {}

  // ── module switch ─────────────────────────────────────────────────────────

  async getEnabled(): Promise<boolean> {
    return await new SettingsService(this.db).getFlag(PROJECT_CHANGELOG_ENABLED_FLAG, true);
  }

  async adminState(): Promise<{ enabled: boolean; updated_at: string | null }> {
    const meta = await new SettingsService(this.db).getWithMeta(PROJECT_CHANGELOG_ENABLED_FLAG);
    return { enabled: await this.getEnabled(), updated_at: meta.updatedAt };
  }

  async setEnabled(enabled: boolean): Promise<{ enabled: boolean; updated_at: string | null }> {
    await new SettingsService(this.db).setFlag(PROJECT_CHANGELOG_ENABLED_FLAG, enabled, { publish: false });
    wsPublisher.publish('settings.changed', { kind: 'project_changelog', enabled });
    return await this.adminState();
  }

  /** Tool handlers call this; discovery filtering alone is not a gate. */
  async assertEnabled(): Promise<void> {
    if (!(await this.getEnabled()))
      throw new ForbiddenError('The project changelog is disabled', 'project_changelog_disabled');
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  private snapshot() {
    return ownerRuntimeFor(this.db)?.state.snapshot() ?? null;
  }

  private ownedRows(projectId: number | null): ChangelogRow[] {
    const state = this.snapshot()!;
    const view = state.table('coordProjectChangelog');
    const rows = projectId === null ? view.all() : view.by('projectId', projectId);
    return rows.map((row) => {
      const body = state.content('coordProjectChangelog', row.id, 'body');
      if (typeof body !== 'string') throw new Error('Current changelog body missing from owner state');
      const { bodyPreview: _p, bodyLength: _l, ...rest } = row as typeof row & { bodyPreview?: string; bodyLength?: number };
      return { ...(rest as Omit<ChangelogRow, 'body'>), body } as ChangelogRow;
    });
  }

  private async projectSlugs(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const state = this.snapshot();
    if (state) {
      const view = state.table('coordProjects');
      return new Map(unique.flatMap((id) => (view.get(id) ? [[id, view.get(id)!.slug] as const] : [])));
    }
    const rows = await this.db
      .select({ id: coordProjects.id, slug: coordProjects.slug })
      .from(coordProjects)
      .where(inArray(coordProjects.id, unique));
    return new Map(rows.map((r) => [r.id, r.slug]));
  }

  private view(row: ChangelogRow, slug: string, preview: boolean, score?: number): ChangelogEntryView {
    const truncated = preview && row.body.length > PREVIEW_CHARS;
    return {
      id: row.id,
      project: slug,
      card_id: row.cardId ?? null,
      kind: row.kind,
      title: row.title,
      body: truncated ? row.body.slice(0, PREVIEW_CHARS) : row.body,
      ...(preview ? { body_truncated: truncated } : {}),
      tags: parseTags(row.tags),
      author_host_id: row.sourceHostId ?? null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      ...(score !== undefined ? { score: Math.round(score * 1000) / 1000 } : {}),
    };
  }

  private matchesFilters(row: ChangelogRow, opts: ChangelogListOptions): boolean {
    if (opts.cardId && row.cardId !== opts.cardId) return false;
    if (opts.kind && row.kind !== opts.kind) return false;
    if (opts.tag && !parseTags(row.tags).includes(opts.tag.toLowerCase())) return false;
    if (opts.beforeId && !(row.id < opts.beforeId)) return false;
    return true;
  }

  private filterSql(opts: ChangelogListOptions): SQL[] {
    const where: SQL[] = [];
    if (opts.cardId) where.push(eq(coordProjectChangelog.cardId, opts.cardId));
    if (opts.kind) where.push(eq(coordProjectChangelog.kind, opts.kind));
    if (opts.beforeId) where.push(lt(coordProjectChangelog.id, opts.beforeId));
    return where;
  }

  private newestFirst(a: ChangelogRow, b: ChangelogRow): number {
    return b.createdAt.localeCompare(a.createdAt) || b.id - a.id;
  }

  private async listRows(projectId: number | null, opts: ChangelogListOptions, limit: number): Promise<ChangelogRow[]> {
    if (this.snapshot()) {
      return this.ownedRows(projectId)
        .filter((row) => this.matchesFilters(row, opts))
        .sort((a, b) => this.newestFirst(a, b))
        .slice(0, limit);
    }
    const where = this.filterSql(opts);
    if (projectId !== null) where.push(eq(coordProjectChangelog.projectId, projectId));
    // Tag filtering happens in JS (JSON column); over-fetch so a tag filter
    // still fills a page in the common case.
    const rows = await this.db
      .select()
      .from(coordProjectChangelog)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(coordProjectChangelog.createdAt), desc(coordProjectChangelog.id))
      .limit(opts.tag ? Math.min(limit * 5, 1000) : limit);
    return rows.filter((row) => this.matchesFilters(row, opts)).slice(0, limit);
  }

  async list(
    slug: string,
    raw: ChangelogListOptions = {},
  ): Promise<{ project: string; entries: ChangelogEntryView[]; next_before_id: number | null }> {
    const project = await this.projects._resolveProject(slug);
    const opts = this.normalizeListOptions(raw);
    const limit = clampLimit(raw.limit);
    const rows = await this.listRows(project.id, opts, limit);
    return {
      project: project.slug,
      entries: rows.map((row) => this.view(row, project.slug, raw.preview === true)),
      next_before_id: rows.length === limit ? rows[rows.length - 1]!.id : null,
    };
  }

  /** Cross-project listing for the admin timeline. */
  async listFleet(
    raw: ChangelogSearchOptions = {},
  ): Promise<{ entries: ChangelogEntryView[]; next_before_id: number | null; degraded?: boolean }> {
    if (str(raw.query)) {
      const found = await this.search({ ...raw, preview: raw.preview ?? true });
      return { entries: found.entries, next_before_id: null, ...(found.degraded ? { degraded: true } : {}) };
    }
    const projectId = raw.slug ? (await this.projects._resolveProject(raw.slug)).id : null;
    const opts = this.normalizeListOptions(raw);
    const limit = clampLimit(raw.limit);
    const rows = await this.listRows(projectId, opts, limit);
    const slugs = await this.projectSlugs(rows.map((r) => r.projectId));
    return {
      entries: rows.map((row) => this.view(row, slugs.get(row.projectId) ?? '', raw.preview ?? true)),
      next_before_id: rows.length === limit ? rows[rows.length - 1]!.id : null,
    };
  }

  async get(slug: string, id: number): Promise<{ project: string; entry: ChangelogEntryView }> {
    const project = await this.projects._resolveProject(slug);
    const row = await this.findRow(project.id, id);
    return { project: project.slug, entry: this.view(row, project.slug, false) };
  }

  /** Newest entries for one card (preview), for `project_card_get` and the card sheet. */
  async forCard(projectId: number, slug: string, cardId: string, limit = 5): Promise<ChangelogEntryView[]> {
    const rows = await this.listRows(projectId, { cardId }, limit);
    return rows.map((row) => this.view(row, slug, true));
  }

  async search(
    raw: ChangelogSearchOptions,
  ): Promise<{ project: string | null; query: string; entries: ChangelogEntryView[]; degraded?: boolean }> {
    const query = str(raw.query);
    const project = raw.slug ? await this.projects._resolveProject(raw.slug) : null;
    const opts = this.normalizeListOptions(raw);
    const limit = clampLimit(raw.limit ?? 20);
    const preview = raw.preview ?? true;
    const projectId = project?.id ?? null;
    if (query === '') {
      const rows = await this.listRows(projectId, opts, limit);
      const slugs = await this.projectSlugs(rows.map((r) => r.projectId));
      return {
        project: project?.slug ?? null,
        query,
        entries: rows.map((row) => this.view(row, slugs.get(row.projectId) ?? '', preview)),
      };
    }

    let scored: Array<{ row: ChangelogRow; score: number }>;
    let degraded = false;
    if (this.snapshot()) {
      scored = this.scoreOwned(this.ownedRows(projectId).filter((row) => this.matchesFilters(row, opts)), query);
    } else {
      const where = this.filterSql(opts);
      if (projectId !== null) where.push(eq(coordProjectChangelog.projectId, projectId));
      try {
        const match = sql<number>`MATCH(${coordProjectChangelog.title}, ${coordProjectChangelog.body}, ${coordProjectChangelog.tagsText}) AGAINST (${query} IN NATURAL LANGUAGE MODE)`;
        const rows = await this.db
          .select({ row: coordProjectChangelog, score: match })
          .from(coordProjectChangelog)
          .where(and(...where, sql`${match} > 0`))
          .orderBy(desc(match), desc(coordProjectChangelog.id))
          .limit(opts.tag ? Math.min(limit * 5, 1000) : limit);
        scored = rows.map((r) => ({ row: r.row, score: Number(r.score) }));
      } catch (err) {
        if (!isMissingFulltextIndex(err)) throw err;
        degraded = true;
        const pattern = `%${query.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
        const rows = await this.db
          .select()
          .from(coordProjectChangelog)
          .where(
            and(
              ...where,
              sql`(${coordProjectChangelog.title} LIKE ${pattern} OR ${coordProjectChangelog.body} LIKE ${pattern} OR ${coordProjectChangelog.tagsText} LIKE ${pattern})`,
            ),
          )
          .orderBy(desc(coordProjectChangelog.createdAt), desc(coordProjectChangelog.id))
          .limit(1000);
        scored = rows.map((row) => ({ row, score: 1 }));
      }
      scored = scored.filter(({ row }) => this.matchesFilters(row, opts));
    }
    const top = scored.slice(0, limit);
    const slugs = await this.projectSlugs(top.map((s) => s.row.projectId));
    return {
      project: project?.slug ?? null,
      query,
      entries: top.map(({ row, score }) => this.view(row, slugs.get(row.projectId) ?? '', preview, score)),
      ...(degraded ? { degraded: true } : {}),
    };
  }

  /** TF-IDF-ish scoring over the owner view; title terms count double. */
  private scoreOwned(rows: ChangelogRow[], query: string): Array<{ row: ChangelogRow; score: number }> {
    const wanted = [...new Set(searchTerms(query))];
    if (!wanted.length) return [];
    const docs = rows.map((row) => {
      const counts = new Map<string, number>();
      for (const term of searchTerms(row.title)) counts.set(term, (counts.get(term) ?? 0) + 2);
      for (const term of searchTerms(row.body + ' ' + (row.tagsText ?? '')))
        counts.set(term, (counts.get(term) ?? 0) + 1);
      return { row, counts };
    });
    const weights = new Map(
      wanted.map((term) => [term, Math.log(1 + docs.length / (docs.filter((d) => d.counts.has(term)).length || 1))]),
    );
    return docs
      .flatMap(({ row, counts }) => {
        let score = 0;
        for (const term of wanted) {
          const n = counts.get(term);
          if (n) score += (1 + Math.log(n)) * weights.get(term)!;
        }
        return score > 0 ? [{ row, score }] : [];
      })
      .sort((a, b) => b.score - a.score || this.newestFirst(a.row, b.row));
  }

  private normalizeListOptions(raw: ChangelogListOptions): ChangelogListOptions {
    const beforeId = raw.beforeId === undefined || raw.beforeId === null ? null : Number(raw.beforeId);
    if (beforeId !== null && (!Number.isInteger(beforeId) || beforeId <= 0))
      throw new ValidationError('before_id must be a positive integer', { param: 'before_id' });
    return {
      cardId: normalizeCardId(raw.cardId),
      kind: raw.kind ? normalizeKind(raw.kind, null) : null,
      tag: str(raw.tag).toLowerCase() || null,
      beforeId,
    };
  }

  private async findRow(projectId: number, id: number): Promise<ChangelogRow> {
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('id must be a positive integer', { param: 'id' });
    if (this.snapshot()) {
      const row = this.ownedRows(projectId).find((r) => r.id === id);
      if (!row) throw new NotFoundError('Changelog entry not found', 'changelog_entry_not_found');
      return row;
    }
    const rows = await this.db
      .select()
      .from(coordProjectChangelog)
      .where(and(eq(coordProjectChangelog.projectId, projectId), eq(coordProjectChangelog.id, id)))
      .limit(1);
    if (!rows[0]) throw new NotFoundError('Changelog entry not found', 'changelog_entry_not_found');
    return rows[0];
  }

  private async assertCard(projectId: number, cardId: string | null): Promise<void> {
    if (cardId === null) return;
    const state = this.snapshot();
    const card = state
      ? state.table('coordProjectCards').get(cardId)
      : (
          await this.db
            .select({ projectId: coordProjectCards.projectId })
            .from(coordProjectCards)
            .where(eq(coordProjectCards.id, cardId))
            .limit(1)
        )[0];
    if (!card || card.projectId !== projectId)
      throw new ValidationError('card_id does not name a card of this project', { param: 'card_id' });
  }

  private assertOwner(row: ChangelogRow, actor: ChangelogActor): void {
    if (actor.operator) return;
    if (actor.hostId === null || row.sourceHostId !== actor.hostId)
      throw new ForbiddenError(
        'Only the host that wrote a changelog entry may change it; append a new entry instead',
        'not_owner',
      );
  }

  // ── writes ────────────────────────────────────────────────────────────────

  private ownerEvent(
    ctx: OwnerMutationContext,
    projectId: number,
    action: string,
    entityId: number,
    payload: Record<string, unknown>,
    hostId: number | null,
  ): void {
    stageProjectEvent(ctx, projectId, 'changelog', action, 'changelog', entityId, payload, hostId);
    if (hostId !== null)
      ctx.write(async (tx) =>
        persistAuditLog(tx, {
          hostId,
          action: 'project.changelog.' + action,
          details: JSON.stringify({ project_id: projectId, entity_id: entityId }),
          createdAt: nowIso(),
          engine: null,
        }),
      );
  }

  private async legacyEvent(
    projectId: number,
    action: string,
    entityId: number,
    payload: Record<string, unknown>,
    hostId: number | null,
  ): Promise<void> {
    await this.projects._recordEvent(projectId, 'changelog', action, 'changelog', entityId, payload, hostId);
    if (hostId !== null)
      await persistAuditLog(this.db, {
        hostId,
        action: 'project.changelog.' + action,
        details: JSON.stringify({ project_id: projectId, entity_id: entityId }),
        createdAt: nowIso(),
        engine: null,
      });
  }

  private publish(slug: string, action: 'created' | 'updated' | 'deleted', id: number, hostId: number | null): void {
    const payload = { slug, entry_id: id, source_host_id: hostId };
    if (action === 'created') wsPublisher.publish('project.changelog.created', payload);
    else if (action === 'updated') wsPublisher.publish('project.changelog.updated', payload);
    else wsPublisher.publish('project.changelog.deleted', payload);
    wsPublisher.publish('project.changed', { slug });
  }

  async append(slug: string, input: Input, actor: ChangelogActor): Promise<{ project: string; entry: ChangelogEntryView }> {
    const project = await this.projects._resolveProject(slug);
    const title = normalizeTitle(input.title);
    const body = normalizeBody(input.body);
    const kind = normalizeKind(input.kind, 'change');
    const tags = normalizeTags(input.tags);
    const cardId = normalizeCardId(input.card_id);
    await this.assertCard(project.id, cardId);
    const now = nowIso();
    const values = {
      projectId: project.id,
      cardId,
      kind,
      title,
      body,
      tags,
      tagsText: tags.join(' ') || null,
      sourceHostId: actor.hostId,
      createdAt: now,
      updatedAt: now,
    };
    const owner = ownerRuntimeFor(this.db);
    let saved!: ChangelogRow;
    if (owner) {
      await mutateOwnerState(owner, {
        kind: 'project.changelog.append',
        payload: { projectId: project.id, title } as unknown as Json,
        prepare: (ctx) => {
          if (!ctx.snapshot.table('coordProjects').has(project.id)) throw new NotFoundError('Project not found');
          ctx.write(async (tx) => {
            const inserted = await tx.insert(coordProjectChangelog).values(values);
            saved = { ...values, id: Number(inserted[0].insertId) } as ChangelogRow;
            ctx.draft.upsert('coordProjectChangelog', saved);
            this.ownerEvent(ctx, project.id, 'create', saved.id, eventState(saved), actor.hostId);
          });
          return () => ({ id: saved.id }) as unknown as Json;
        },
      });
    } else {
      const inserted = await this.db.insert(coordProjectChangelog).values(values).$returningId();
      saved = { ...values, id: inserted[0]!.id } as ChangelogRow;
      await this.legacyEvent(project.id, 'create', saved.id, eventState(saved), actor.hostId);
    }
    this.publish(project.slug, 'created', saved.id, actor.hostId);
    return { project: project.slug, entry: this.view(saved, project.slug, false) };
  }

  async update(
    slug: string,
    id: number,
    input: Input,
    actor: ChangelogActor,
  ): Promise<{ project: string; entry: ChangelogEntryView }> {
    const project = await this.projects._resolveProject(slug);
    const current = await this.findRow(project.id, id);
    this.assertOwner(current, actor);
    const patch: Partial<ChangelogRow> = {};
    if (input.title !== undefined) patch.title = normalizeTitle(input.title);
    if (input.body !== undefined) patch.body = normalizeBody(input.body);
    if (input.kind !== undefined) patch.kind = normalizeKind(input.kind, null);
    if (input.tags !== undefined) {
      const tags = normalizeTags(input.tags);
      patch.tags = tags;
      patch.tagsText = tags.join(' ') || null;
    }
    if (input.card_id !== undefined) {
      patch.cardId = normalizeCardId(input.card_id);
      await this.assertCard(project.id, patch.cardId);
    }
    if (!Object.keys(patch).length) throw new ValidationError('nothing to update');
    patch.updatedAt = nowIso();
    const next = { ...current, ...patch } as ChangelogRow;
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      await mutateOwnerState(owner, {
        kind: 'project.changelog.update',
        payload: { projectId: project.id, id } as unknown as Json,
        prepare: (ctx) => {
          const old = ctx.snapshot.table('coordProjectChangelog').get(id);
          if (old?.projectId !== project.id)
            throw new NotFoundError('Changelog entry not found', 'changelog_entry_not_found');
          if (!actor.operator && old.sourceHostId !== actor.hostId)
            throw new ForbiddenError('Only the host that wrote a changelog entry may change it', 'not_owner');
          stageUpdate(ctx, 'coordProjectChangelog', id, patch);
          this.ownerEvent(ctx, project.id, 'update', id, eventState(next), actor.hostId);
          return { id } as unknown as Json;
        },
      });
    } else {
      await this.db.update(coordProjectChangelog).set(patch).where(eq(coordProjectChangelog.id, id));
      await this.legacyEvent(project.id, 'update', id, eventState(next), actor.hostId);
    }
    this.publish(project.slug, 'updated', id, actor.hostId);
    return { project: project.slug, entry: this.view(next, project.slug, false) };
  }

  async delete(slug: string, id: number, actor: ChangelogActor): Promise<{ project: string; deleted: number }> {
    const project = await this.projects._resolveProject(slug);
    const current = await this.findRow(project.id, id);
    this.assertOwner(current, actor);
    // The removed state rides on the event: the feed keeps what was deleted.
    const payload = eventState(current);
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      await mutateOwnerState(owner, {
        kind: 'project.changelog.delete',
        payload: { projectId: project.id, id } as unknown as Json,
        prepare: (ctx) => {
          const old = ctx.snapshot.table('coordProjectChangelog').get(id);
          if (old?.projectId !== project.id)
            throw new NotFoundError('Changelog entry not found', 'changelog_entry_not_found');
          if (!actor.operator && old.sourceHostId !== actor.hostId)
            throw new ForbiddenError('Only the host that wrote a changelog entry may change it', 'not_owner');
          stageDelete(ctx, 'coordProjectChangelog', id);
          this.ownerEvent(ctx, project.id, 'delete', id, payload, actor.hostId);
          return { deleted: id } as unknown as Json;
        },
      });
    } else {
      await this.db.delete(coordProjectChangelog).where(eq(coordProjectChangelog.id, id));
      await this.legacyEvent(project.id, 'delete', id, payload, actor.hostId);
    }
    this.publish(project.slug, 'deleted', id, actor.hostId);
    return { project: project.slug, deleted: id };
  }
}

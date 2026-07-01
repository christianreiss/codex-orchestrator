/**
 * Projects domain service. CRUD on `coord_projects` + cascades.
 *
 * Every mutation:
 *   1. Allocates the next `seq` for the project via an UPDATE that increments
 *      `coord_projects.latest_event_seq`.
 *   2. Writes an audit row to `coord_project_events` BEFORE publishing WS.
 *   3. Publishes the corresponding `project.*` WS event so the WebUI
 *      can invalidate caches.
 *
 * The legacy `ProjectModuleService` gated all operations on a
 * `projects_module_enabled` flag stored in the `versions` table. We honor
 * that flag via the `state` / `setEnabled` methods, but admin CRUD does not
 * additionally check the flag — the legacy admin paths bypassed the gate
 * for management operations as well, so we follow that convention.
 */
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  coordProjectEvents,
  coordProjectFeedback,
  coordProjectFiles,
  coordProjectNotes,
  coordProjectTodos,
  coordProjects,
  versions,
} from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';

const PROJECTS_ENABLED_FLAG = 'projects_module_enabled';
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MANAGED_SKILL_SLUG = 'coco';

export interface ProjectSummary {
  slug: string;
  title: string;
  name: string;
  description: string;
  about: Record<string, unknown> | null;
  latest_seq: number;
  created_at: string;
  updated_at: string;
}

export function normalizeSlug(value: unknown): string {
  const slug = typeof value === 'string' ? value.trim() : '';
  if (slug === '') throw new ValidationError('slug is required', { param: 'slug' });
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError('slug must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/', { param: 'slug' });
  }
  return slug;
}

export function normalizeAbout(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('about must be an object', { param: 'about' });
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.trim() === '') continue;
    if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) {
      out[key] = typeof entry === 'string' ? entry.trim() : entry;
    } else if (Array.isArray(entry) || (typeof entry === 'object')) {
      out[key] = entry;
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

export function normalizeRoster(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > 65535) {
    throw new ValidationError('roster_markdown must be 65535 characters or fewer', { param: 'roster_markdown' });
  }
  return text;
}

export function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function buildSummary(project: typeof coordProjects.$inferSelect): ProjectSummary {
  const about = (project.aboutJson && typeof project.aboutJson === 'object' && !Array.isArray(project.aboutJson))
    ? (project.aboutJson as Record<string, unknown>)
    : null;
  const slug = project.slug;
  return {
    slug,
    title: normalizeOptionalString(about?.title) ?? slug,
    name: normalizeOptionalString(about?.name) ?? slug,
    description: normalizeOptionalString(about?.description) ?? '',
    about,
    latest_seq: project.latestEventSeq,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

export class ProjectsService {
  constructor(private readonly db: Database) {}

  /**
   * Read the projects_module_enabled flag from the `versions` table.
   */
  async getEnabled(): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(versions)
      .where(eq(versions.name, PROJECTS_ENABLED_FLAG))
      .limit(1);
    return rows[0]?.version === '1';
  }

  async adminState(): Promise<{ enabled: boolean; updated_at: string | null; managed_skill: { slug: string; uri: string } }> {
    const rows = await this.db
      .select()
      .from(versions)
      .where(eq(versions.name, PROJECTS_ENABLED_FLAG))
      .limit(1);
    return {
      enabled: rows[0]?.version === '1',
      updated_at: rows[0]?.updatedAt ?? null,
      managed_skill: {
        slug: MANAGED_SKILL_SLUG,
        uri: `skill://${MANAGED_SKILL_SLUG}`,
      },
    };
  }

  async setEnabled(enabled: boolean): Promise<{ enabled: boolean; updated_at: string | null; managed_skill: { slug: string; uri: string } }> {
    const nowTs = nowIso();
    const existing = await this.db
      .select()
      .from(versions)
      .where(eq(versions.name, PROJECTS_ENABLED_FLAG))
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(versions)
        .set({ version: enabled ? '1' : '0', updatedAt: nowTs })
        .where(eq(versions.name, PROJECTS_ENABLED_FLAG));
    } else {
      await this.db
        .insert(versions)
        .values({ name: PROJECTS_ENABLED_FLAG, version: enabled ? '1' : '0', updatedAt: nowTs });
    }
    wsPublisher.publish('settings.changed', { kind: 'projects_module', enabled });
    return await this.adminState();
  }

  async list(): Promise<{ projects: ProjectSummary[] }> {
    const rows = await this.db
      .select()
      .from(coordProjects)
      .orderBy(asc(coordProjects.slug));
    return { projects: rows.map(buildSummary) };
  }

  private async requireProject(rawSlug: string): Promise<typeof coordProjects.$inferSelect> {
    const slug = normalizeSlug(rawSlug);
    const rows = await this.db
      .select()
      .from(coordProjects)
      .where(eq(coordProjects.slug, slug))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('Project not found', 'project_not_found');
    return row;
  }

  /**
   * Atomically allocate the next event sequence and write the audit row,
   * keeping `coord_projects.latest_event_seq` aligned with the row.
   */
  private async recordEvent(
    projectId: number,
    eventType: string,
    action: string,
    entityType: string | null,
    entityId: number | string | null,
    payload: Record<string, unknown> | null,
    sourceHostId: number | null,
  ): Promise<{ seq: number; id: number }> {
    if (projectId <= 0) {
      throw new Error('recordEvent requires a stored project');
    }
    const nowTs = nowIso();
    // Increment latest_event_seq and read back the new value atomically:
    // lock the project row for the duration of the transaction so concurrent
    // mutations on the same project can't allocate the same seq.
    return await this.db.transaction(async (tx) => {
      const lockedRows = await tx
        .select({ seq: coordProjects.latestEventSeq })
        .from(coordProjects)
        .where(eq(coordProjects.id, projectId))
        .for('update');
      const seq = (lockedRows[0]?.seq ?? 0) + 1;

      await tx
        .update(coordProjects)
        .set({ latestEventSeq: seq, updatedAt: nowTs })
        .where(eq(coordProjects.id, projectId));

      const inserted = await tx.insert(coordProjectEvents).values({
        projectId,
        seq,
        eventType,
        action,
        entityType,
        entityId: entityId === null ? null : String(entityId),
        payloadJson: payload as unknown as Record<string, unknown> | null,
        sourceHostId,
        createdAt: nowTs,
      }).$returningId();

      return { seq, id: inserted[0]?.id ?? 0 };
    });
  }

  async create(payload: { slug?: unknown; about?: unknown; roster_markdown?: unknown; agents_markdown?: unknown }, sourceHostId: number | null = null): Promise<ProjectDetail> {
    const slug = normalizeSlug(payload.slug);
    const about = normalizeAbout(payload.about);
    const roster = normalizeRoster(payload.roster_markdown ?? payload.agents_markdown);

    const existing = await this.db
      .select({ id: coordProjects.id })
      .from(coordProjects)
      .where(eq(coordProjects.slug, slug))
      .limit(1);
    if (existing[0]) {
      throw new ConflictError('slug already exists', 'project_slug_taken');
    }

    const nowTs = nowIso();
    const inserted = await this.db.insert(coordProjects).values({
      slug,
      aboutJson: about as unknown as Record<string, unknown> | null,
      rosterMarkdown: roster,
      latestEventSeq: 0,
      createdAt: nowTs,
      updatedAt: nowTs,
    }).$returningId();
    const newId = inserted[0]?.id ?? 0;

    await this.recordEvent(newId, 'project', 'create', 'project', newId, {
      slug,
      about,
    }, sourceHostId);

    wsPublisher.publish('project.created', { slug, id: newId });
    wsPublisher.publish('project.changed', { slug });

    return await this.detail(slug);
  }

  async deleteBySlug(rawSlug: string, _sourceHostId: number | null = null): Promise<{ deleted: string }> {
    const project = await this.requireProject(rawSlug);
    // Cascades: notes, todos, files, feedback, events are FK-attached;
    // delete in dependency order, all-or-nothing.
    await this.db.transaction(async (tx) => {
      await tx.delete(coordProjectNotes).where(eq(coordProjectNotes.projectId, project.id));
      await tx.delete(coordProjectTodos).where(eq(coordProjectTodos.projectId, project.id));
      await tx.delete(coordProjectFiles).where(eq(coordProjectFiles.projectId, project.id));
      await tx.delete(coordProjectFeedback).where(eq(coordProjectFeedback.projectId, project.id));
      await tx.delete(coordProjectEvents).where(eq(coordProjectEvents.projectId, project.id));
      await tx.delete(coordProjects).where(eq(coordProjects.id, project.id));
    });

    wsPublisher.publish('project.deleted', { slug: project.slug, id: project.id });
    wsPublisher.publish('project.changed', { slug: project.slug });
    return { deleted: project.slug };
  }

  async detail(rawSlug: string): Promise<ProjectDetail> {
    const project = await this.requireProject(rawSlug);
    const [notes, todos, files, feedback, recentChanges] = await Promise.all([
      this.db.select().from(coordProjectNotes).where(eq(coordProjectNotes.projectId, project.id)).orderBy(desc(coordProjectNotes.updatedAt)),
      this.db.select().from(coordProjectTodos).where(eq(coordProjectTodos.projectId, project.id)).orderBy(desc(coordProjectTodos.updatedAt)),
      this.db.select().from(coordProjectFiles).where(eq(coordProjectFiles.projectId, project.id)).orderBy(asc(coordProjectFiles.storedName)),
      this.db.select().from(coordProjectFeedback).where(eq(coordProjectFeedback.projectId, project.id)).orderBy(desc(coordProjectFeedback.updatedAt)),
      this.db.select().from(coordProjectEvents).where(eq(coordProjectEvents.projectId, project.id)).orderBy(desc(coordProjectEvents.seq)).limit(20),
    ]);

    const todoViews: TodoView[] = todos.map((t) => ({
      ...t,
      done: Boolean(t.done),
    }));
    const fileViews = files.map(formatFile);
    return {
      project: {
        slug: project.slug,
        about: (project.aboutJson && typeof project.aboutJson === 'object' && !Array.isArray(project.aboutJson))
          ? (project.aboutJson as Record<string, unknown>)
          : null,
        roster_markdown: project.rosterMarkdown ?? '',
        latest_seq: project.latestEventSeq,
        created_at: project.createdAt,
        updated_at: project.updatedAt,
        counts: {
          notes: notes.length,
          open_todos: todoViews.filter((t) => !t.done).length,
          done_todos: todoViews.filter((t) => t.done).length,
          files: fileViews.length,
          feedback: feedback.length,
        },
      },
      notes,
      todos: todoViews,
      files: fileViews,
      feedback,
      recent_changes: recentChanges.reverse(),
    };
  }

  async updateAbout(rawSlug: string, payload: { about?: unknown } | Record<string, unknown>, sourceHostId: number | null = null): Promise<{ project: ProjectSummary; about: Record<string, unknown> | null }> {
    const project = await this.requireProject(rawSlug);
    const about = normalizeAbout('about' in payload && payload.about !== undefined ? (payload as { about: unknown }).about : payload);
    const nowTs = nowIso();
    await this.db
      .update(coordProjects)
      .set({ aboutJson: about as unknown as Record<string, unknown> | null, updatedAt: nowTs })
      .where(eq(coordProjects.id, project.id));
    await this.recordEvent(project.id, 'about', 'update', 'project', project.id, { about }, sourceHostId);

    wsPublisher.publish('project.updated', { slug: project.slug, id: project.id });
    wsPublisher.publish('project.changed', { slug: project.slug });

    const refreshed = await this.requireProject(rawSlug);
    return { project: buildSummary(refreshed), about };
  }

  async updateRoster(rawSlug: string, payload: { roster_markdown?: unknown; markdown?: unknown }, sourceHostId: number | null = null): Promise<{ project: ProjectSummary; roster_markdown: string }> {
    const project = await this.requireProject(rawSlug);
    const roster = normalizeRoster(payload.roster_markdown ?? payload.markdown ?? '');
    const nowTs = nowIso();
    await this.db
      .update(coordProjects)
      .set({ rosterMarkdown: roster, updatedAt: nowTs })
      .where(eq(coordProjects.id, project.id));
    await this.recordEvent(project.id, 'roster', 'update', 'project', project.id, { roster_markdown: roster }, sourceHostId);

    wsPublisher.publish('project.updated', { slug: project.slug, id: project.id });
    wsPublisher.publish('project.changed', { slug: project.slug });

    const refreshed = await this.requireProject(rawSlug);
    return { project: buildSummary(refreshed), roster_markdown: roster };
  }

  async listChanges(rawSlug: string, since = 0): Promise<{ project: string; since: number; latest_seq: number; changes: typeof coordProjectEvents.$inferSelect[] }> {
    const project = await this.requireProject(rawSlug);
    const safeSince = Math.max(0, since);
    const rows = safeSince === 0
      ? await this.db
          .select()
          .from(coordProjectEvents)
          .where(eq(coordProjectEvents.projectId, project.id))
          .orderBy(asc(coordProjectEvents.seq))
          .limit(200)
      : await this.db
          .select()
          .from(coordProjectEvents)
          .where(and(eq(coordProjectEvents.projectId, project.id), gt(coordProjectEvents.seq, safeSince)))
          .orderBy(asc(coordProjectEvents.seq))
          .limit(200);
    return {
      project: project.slug,
      since: safeSince,
      latest_seq: project.latestEventSeq,
      changes: rows,
    };
  }

  /**
   * Helper exposed to sub-resource services (notes/todos/files/feedback).
   */
  async _resolveProject(rawSlug: string): Promise<typeof coordProjects.$inferSelect> {
    return await this.requireProject(rawSlug);
  }

  /**
   * Helper exposed to sub-resource services to record events + publish WS.
   */
  async _recordEvent(
    projectId: number,
    eventType: string,
    action: string,
    entityType: string | null,
    entityId: number | string | null,
    payload: Record<string, unknown> | null,
    sourceHostId: number | null,
  ): Promise<{ seq: number; id: number }> {
    return await this.recordEvent(projectId, eventType, action, entityType, entityId, payload, sourceHostId);
  }
}

export interface ProjectDetail {
  project: {
    slug: string;
    about: Record<string, unknown> | null;
    roster_markdown: string;
    latest_seq: number;
    created_at: string;
    updated_at: string;
    counts: { notes: number; open_todos: number; done_todos: number; files: number; feedback: number };
  };
  notes: typeof coordProjectNotes.$inferSelect[];
  todos: TodoView[];
  files: ProjectFileView[];
  feedback: typeof coordProjectFeedback.$inferSelect[];
  recent_changes: typeof coordProjectEvents.$inferSelect[];
}

export type TodoView = Omit<typeof coordProjectTodos.$inferSelect, 'done'> & { done: boolean };

export interface ProjectFileView {
  id: number;
  stored_name: string;
  description: string | null;
  content_sha256: string;
  mime_type: string | null;
  size_bytes: number;
  updated_at: string;
  created_at: string;
  content: string;
}

export function formatFile(file: typeof coordProjectFiles.$inferSelect): ProjectFileView {
  const content = file.content ?? '';
  return {
    id: file.id,
    stored_name: file.storedName,
    description: file.description,
    content_sha256: file.contentSha256,
    mime_type: file.mimeType,
    size_bytes: Buffer.byteLength(content, 'utf8'),
    updated_at: file.updatedAt,
    created_at: file.createdAt,
    content,
  };
}

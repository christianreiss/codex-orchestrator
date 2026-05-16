/**
 * Host-facing project coordination service. Mirrors the legacy
 * src/Services/ProjectCoordinationService.php API surface (and its
 * ProjectNormalizer companion) but issued against the Drizzle schema.
 *
 * Every mutation records a `coord_project_events` row (audit log) and
 * publishes a matching `project.*` WS event. The host (the authenticated
 * caller) is recorded in `source_host_id`.
 */
import { eq, and, gt, asc, desc, sql, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  coordProjects,
  coordProjectNotes,
  coordProjectTodos,
  coordProjectFiles,
  coordProjectFeedback,
  coordProjectEvents,
  logs,
} from '../db/schema.js';
import { ValidationError, NotFoundError, ConflictError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import type { Host } from '../db/schema.js';
import { createHash } from 'node:crypto';

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const STORED_NAME_RE = /^[^\0]+$/;
const FEEDBACK_TYPES = new Set(['bug', 'feature', 'note']);

export interface ProjectSummary {
  slug: string;
  title: string;
  name: string;
  description: string;
  about: Record<string, unknown> | null;
  latest_seq: number;
  created_at: string | null;
  updated_at: string | null;
}

interface ProjectRow {
  id: number;
  slug: string;
  about: Record<string, unknown> | null;
  roster_markdown: string;
  latest_event_seq: number;
  created_at: string | null;
  updated_at: string | null;
  archived_at: string | null;
}

interface NoteRow {
  id: number;
  project_id: number;
  header: string;
  body: string;
  source_host_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

interface TodoRow {
  id: number;
  project_id: number;
  title: string;
  detail: string;
  done: boolean;
  done_at: string | null;
  source_host_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

interface FileRow {
  id: number;
  project_id: number;
  stored_name: string;
  description: string | null;
  content: string;
  content_sha256: string;
  mime_type: string | null;
  size_bytes: number;
  source_host_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

interface FeedbackRow {
  id: number;
  project_id: number;
  type: string;
  title: string;
  body: string;
  status: string;
  source_host_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

interface EventRow {
  seq: number;
  project_id: number;
  event_type: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown> | null;
  source_host_id: number | null;
  created_at: string | null;
}

export class HostProjectsService {
  constructor(private readonly db: Database) {}

  async listProjects(host: Host): Promise<{ projects: ProjectSummary[] }> {
    const rows = await this.db
      .select()
      .from(coordProjects)
      .where(isNull(coordProjects.archivedAt))
      .orderBy(desc(coordProjects.updatedAt), asc(coordProjects.slug));
    const summaries = rows.map((r) => this.buildSummary(this.hydrateProject(r)));
    await this.recordLog(host.id, 'project.list', { count: summaries.length });
    return { projects: summaries };
  }

  async createProject(payload: Record<string, unknown>, host: Host): Promise<unknown> {
    const slug = this.normalizeSlug(payload['slug'] ?? payload['project']);
    const about = this.normalizeAbout(payload['about']);
    const roster = this.normalizeRoster(payload['roster_markdown'] ?? payload['agents_markdown'] ?? '');

    const existing = await this.findBySlug(slug, true);
    if (existing) {
      throw new ValidationError('Validation failed', { extra: { errors: { slug: ['slug already exists'] } } });
    }

    const now = nowIso();
    await this.db.insert(coordProjects).values({
      slug,
      aboutJson: about,
      rosterMarkdown: roster,
      latestEventSeq: 0,
      createdAt: now,
      updatedAt: now,
    });
    const created = (await this.findBySlug(slug, true))!;
    await this.recordEvent(
      created,
      'project',
      'create',
      'project',
      String(created.id),
      { slug: created.slug, about: created.about },
      host.id,
    );
    await this.recordLog(host.id, 'project.create', { slug });
    wsPublisher.publish('project.created', { slug, source_host_id: host.id });
    return this.projectDetail(slug, host);
  }

  async bootstrap(slug: string, host: Host): Promise<Record<string, unknown>> {
    const project = await this.requireProject(slug);
    const detail = await this.buildDetail(project, host, false);
    const encoded = encodeURIComponent(project.slug);
    const detailRoute = `/projects/${encoded}`;
    return {
      project: project.slug,
      about: detail.project.about,
      roster_markdown: detail.project.roster_markdown,
      latest_seq: detail.project.latest_seq,
      counts: detail.project.counts,
      recent_notes: detail.notes.slice(0, 3),
      recent_todos: detail.todos.slice(0, 6),
      recent_files: detail.files.slice(0, 5),
      recent_changes: detail.recent_changes.slice(-10),
      skill: null,
      instructions: null,
      quickstart: null,
      routes: {
        detail: detailRoute,
        bootstrap: `${detailRoute}/bootstrap`,
        notes: `${detailRoute}/notes`,
        todos: `${detailRoute}/todos`,
        files: `${detailRoute}/files`,
        feedback: `${detailRoute}/feedback`,
        changes: `${detailRoute}/changes`,
      },
    };
  }

  async projectDetail(slug: string, host: Host): Promise<{
    project: {
      slug: string;
      about: Record<string, unknown> | null;
      roster_markdown: string;
      latest_seq: number;
      created_at: string | null;
      updated_at: string | null;
      counts: Record<string, number>;
    };
    notes: NoteRow[];
    todos: TodoRow[];
    files: FileRow[];
    feedback: FeedbackRow[];
    recent_changes: EventRow[];
  }> {
    const project = await this.requireProject(slug);
    return this.buildDetail(project, host, true);
  }

  async updateAbout(slug: string, payload: Record<string, unknown>, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const aboutRaw = (payload as Record<string, unknown>)['about'] ?? payload;
    const about = this.normalizeAbout(aboutRaw);
    const now = nowIso();
    await this.db
      .update(coordProjects)
      .set({ aboutJson: about, updatedAt: now })
      .where(eq(coordProjects.id, project.id));
    const updated = (await this.findById(project.id))!;
    await this.recordEvent(updated, 'about', 'update', 'project', String(updated.id), { about: updated.about }, host.id);
    await this.recordLog(host.id, 'project.about.update', { slug: updated.slug });
    wsPublisher.publish('project.updated', { slug: updated.slug, source_host_id: host.id });
    return { project: this.buildSummary(updated), about: updated.about };
  }

  async updateRoster(slug: string, payload: Record<string, unknown>, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const roster = this.normalizeRoster(payload['roster_markdown'] ?? payload['markdown'] ?? '');
    const now = nowIso();
    await this.db
      .update(coordProjects)
      .set({ rosterMarkdown: roster, updatedAt: now })
      .where(eq(coordProjects.id, project.id));
    const updated = (await this.findById(project.id))!;
    await this.recordEvent(updated, 'roster', 'update', 'project', String(updated.id), { roster_markdown: updated.roster_markdown }, host.id);
    await this.recordLog(host.id, 'project.roster.update', { slug: updated.slug });
    wsPublisher.publish('project.updated', { slug: updated.slug, source_host_id: host.id });
    return { project: this.buildSummary(updated), roster_markdown: updated.roster_markdown };
  }

  async listChanges(slug: string, since: number, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const safeSince = Math.max(0, since | 0);
    const rows = await this.db
      .select()
      .from(coordProjectEvents)
      .where(and(eq(coordProjectEvents.projectId, project.id), gt(coordProjectEvents.seq, safeSince)))
      .orderBy(asc(coordProjectEvents.seq))
      .limit(200);
    const changes = rows.map((r) => this.hydrateEvent(r));
    await this.recordLog(host.id, 'project.changes', { slug: project.slug, since: safeSince, count: changes.length });
    return {
      project: project.slug,
      since: safeSince,
      latest_seq: project.latest_event_seq,
      changes,
    };
  }

  async listNotes(slug: string, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const rows = await this.fetchNotes(project.id);
    await this.recordLog(host.id, 'project.notes.list', { slug: project.slug, count: rows.length });
    return { project: project.slug, notes: rows };
  }

  async upsertNote(slug: string, id: number | null, payload: Record<string, unknown>, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const { header, body } = this.normalizeNotePayload(payload);
    const now = nowIso();
    let savedId: number;
    let eventAction: 'create' | 'update';

    if (id === null) {
      const inserted = await this.db.insert(coordProjectNotes).values({
        projectId: project.id,
        header,
        body,
        sourceHostId: host.id,
        createdAt: now,
        updatedAt: now,
      });
      const insertId = (inserted[0] as { insertId?: number })?.insertId;
      if (!insertId) throw new Error('failed to insert note');
      savedId = Number(insertId);
      eventAction = 'create';
    } else {
      const existingRow = await this.db
        .select()
        .from(coordProjectNotes)
        .where(and(eq(coordProjectNotes.projectId, project.id), eq(coordProjectNotes.id, id)))
        .limit(1);
      if (!existingRow[0]) throw new NotFoundError('Note not found');
      await this.db
        .update(coordProjectNotes)
        .set({ header, body, sourceHostId: host.id, updatedAt: now })
        .where(and(eq(coordProjectNotes.projectId, project.id), eq(coordProjectNotes.id, id)));
      savedId = id;
      eventAction = 'update';
    }

    const savedRows = await this.db.select().from(coordProjectNotes).where(eq(coordProjectNotes.id, savedId)).limit(1);
    const saved = savedRows[0] ? this.hydrateNote(savedRows[0]) : null;

    await this.recordEvent(project, 'note', eventAction, 'note', String(savedId), {
      header: saved?.header ?? header,
      body: saved?.body ?? body,
    }, host.id);
    await this.recordLog(host.id, `project.note.${eventAction}`, { slug: project.slug, note_id: savedId });
    wsPublisher.publish(`project.note.${eventAction === 'create' ? 'created' : 'updated'}`, {
      slug: project.slug,
      note_id: savedId,
      source_host_id: host.id,
    });

    return { project: project.slug, note: saved };
  }

  async deleteNote(slug: string, id: number, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const existing = await this.db
      .select()
      .from(coordProjectNotes)
      .where(and(eq(coordProjectNotes.projectId, project.id), eq(coordProjectNotes.id, id)))
      .limit(1);
    if (!existing[0]) throw new NotFoundError('Note not found');
    await this.db.delete(coordProjectNotes).where(and(eq(coordProjectNotes.projectId, project.id), eq(coordProjectNotes.id, id)));
    await this.recordEvent(project, 'note', 'delete', 'note', String(id), { id }, host.id);
    await this.recordLog(host.id, 'project.note.delete', { slug: project.slug, note_id: id });
    wsPublisher.publish('project.note.deleted', { slug: project.slug, note_id: id, source_host_id: host.id });
    return { project: project.slug, deleted: id };
  }

  async listTodos(slug: string, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const todos = await this.fetchTodos(project.id);
    await this.recordLog(host.id, 'project.todos.list', { slug: project.slug, count: todos.length });
    return { project: project.slug, todos };
  }

  async createTodo(slug: string, payload: Record<string, unknown>, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const { title, detail } = this.normalizeTodoPayload(payload);
    const now = nowIso();
    const result = await this.db.insert(coordProjectTodos).values({
      projectId: project.id,
      title,
      detail,
      done: 0,
      doneAt: null,
      sourceHostId: host.id,
      createdAt: now,
      updatedAt: now,
    });
    const insertId = Number((result[0] as { insertId?: number })?.insertId ?? 0);
    const todoRow = await this.fetchTodoById(project.id, insertId);
    await this.recordEvent(project, 'todo', 'create', 'todo', String(insertId), todoRow as unknown as Record<string, unknown>, host.id);
    await this.recordLog(host.id, 'project.todo.create', { slug: project.slug, todo_id: insertId });
    wsPublisher.publish('project.todo.created', { slug: project.slug, todo_id: insertId, source_host_id: host.id });
    return { project: project.slug, todo: todoRow };
  }

  async updateTodo(slug: string, id: number, payload: Record<string, unknown>, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const existing = await this.fetchTodoById(project.id, id);
    if (!existing) throw new NotFoundError('Todo not found');
    const { title, detail } = this.normalizeTodoPayload(payload);
    const now = nowIso();
    await this.db
      .update(coordProjectTodos)
      .set({ title, detail, sourceHostId: host.id, updatedAt: now })
      .where(and(eq(coordProjectTodos.projectId, project.id), eq(coordProjectTodos.id, id)));
    const todoRow = await this.fetchTodoById(project.id, id);
    await this.recordEvent(project, 'todo', 'update', 'todo', String(id), todoRow as unknown as Record<string, unknown>, host.id);
    await this.recordLog(host.id, 'project.todo.update', { slug: project.slug, todo_id: id });
    wsPublisher.publish('project.todo.updated', { slug: project.slug, todo_id: id, source_host_id: host.id });
    return { project: project.slug, todo: todoRow };
  }

  async setTodoDone(slug: string, id: number, done: boolean, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const existing = await this.fetchTodoById(project.id, id);
    if (!existing) throw new NotFoundError('Todo not found');
    const now = nowIso();
    await this.db
      .update(coordProjectTodos)
      .set({ done: done ? 1 : 0, doneAt: done ? now : null, sourceHostId: host.id, updatedAt: now })
      .where(and(eq(coordProjectTodos.projectId, project.id), eq(coordProjectTodos.id, id)));
    const todoRow = await this.fetchTodoById(project.id, id);
    const action = done ? 'mark_done' : 'mark_undone';
    await this.recordEvent(project, 'todo', action, 'todo', String(id), todoRow as unknown as Record<string, unknown>, host.id);
    await this.recordLog(host.id, 'project.todo.done', { slug: project.slug, todo_id: id, done });
    wsPublisher.publish('project.todo.updated', { slug: project.slug, todo_id: id, done, source_host_id: host.id });
    return { project: project.slug, todo: todoRow };
  }

  async deleteTodo(slug: string, id: number, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const existing = await this.fetchTodoById(project.id, id);
    if (!existing) throw new NotFoundError('Todo not found');
    await this.db.delete(coordProjectTodos).where(and(eq(coordProjectTodos.projectId, project.id), eq(coordProjectTodos.id, id)));
    await this.recordEvent(project, 'todo', 'delete', 'todo', String(id), { id }, host.id);
    await this.recordLog(host.id, 'project.todo.delete', { slug: project.slug, todo_id: id });
    wsPublisher.publish('project.todo.deleted', { slug: project.slug, todo_id: id, source_host_id: host.id });
    return { project: project.slug, deleted: id };
  }

  async listFiles(slug: string, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const files = await this.fetchFiles(project.id);
    await this.recordLog(host.id, 'project.files.list', { slug: project.slug, count: files.length });
    return { project: project.slug, files };
  }

  async upsertFile(slug: string, payload: Record<string, unknown>, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const { storedName, description, content, mimeType } = this.normalizeFilePayload(payload);
    const sha = createHash('sha256').update(content).digest('hex');
    const now = nowIso();
    const existing = await this.db
      .select()
      .from(coordProjectFiles)
      .where(and(eq(coordProjectFiles.projectId, project.id), eq(coordProjectFiles.storedName, storedName)))
      .limit(1);
    let savedId: number;
    let action: 'create' | 'update';
    if (existing[0]) {
      savedId = Number(existing[0].id);
      action = 'update';
      await this.db
        .update(coordProjectFiles)
        .set({
          description: description ?? null,
          content,
          contentSha256: sha,
          mimeType: mimeType ?? null,
          sourceHostId: host.id,
          updatedAt: now,
        })
        .where(eq(coordProjectFiles.id, existing[0].id));
    } else {
      const inserted = await this.db.insert(coordProjectFiles).values({
        projectId: project.id,
        storedName,
        description: description ?? null,
        content,
        contentSha256: sha,
        mimeType: mimeType ?? null,
        sourceHostId: host.id,
        createdAt: now,
        updatedAt: now,
      });
      savedId = Number((inserted[0] as { insertId?: number })?.insertId ?? 0);
      action = 'create';
    }

    const fileRow = await this.fetchFileById(project.id, savedId);
    if (fileRow) {
      await this.recordEvent(project, 'file', action, 'file', String(savedId), {
        id: savedId,
        stored_name: fileRow.stored_name,
        description: fileRow.description,
        content_sha256: fileRow.content_sha256,
        mime_type: fileRow.mime_type,
        size_bytes: fileRow.size_bytes,
        updated_at: fileRow.updated_at,
        created_at: fileRow.created_at,
      }, host.id);
    }
    await this.recordLog(host.id, `project.file.${action}`, { slug: project.slug, file_id: savedId, stored_name: storedName });
    wsPublisher.publish('project.file.upserted', { slug: project.slug, file_id: savedId, source_host_id: host.id });
    return { project: project.slug, file: fileRow };
  }

  async deleteFile(slug: string, id: number, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const existing = await this.fetchFileById(project.id, id);
    if (!existing) throw new NotFoundError('Project file not found');
    await this.db.delete(coordProjectFiles).where(and(eq(coordProjectFiles.projectId, project.id), eq(coordProjectFiles.id, id)));
    await this.recordEvent(project, 'file', 'delete', 'file', String(id), { id, stored_name: existing.stored_name }, host.id);
    await this.recordLog(host.id, 'project.file.delete', { slug: project.slug, file_id: id });
    wsPublisher.publish('project.file.deleted', { slug: project.slug, file_id: id, source_host_id: host.id });
    return { project: project.slug, deleted: id };
  }

  async listFeedback(slug: string, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const items = await this.fetchFeedback(project.id);
    await this.recordLog(host.id, 'project.feedback.list', { project: project.slug, count: items.length });
    return { project: project.slug, feedback: items };
  }

  async createFeedback(slug: string, payload: Record<string, unknown>, host: Host): Promise<unknown> {
    const project = await this.requireProject(slug);
    const { type, title, body } = this.normalizeFeedbackPayload(payload);
    const now = nowIso();
    const inserted = await this.db.insert(coordProjectFeedback).values({
      projectId: project.id,
      type,
      title,
      body,
      status: 'open',
      sourceHostId: host.id,
      createdAt: now,
      updatedAt: now,
    });
    const savedId = Number((inserted[0] as { insertId?: number })?.insertId ?? 0);
    const row = await this.fetchFeedbackById(project.id, savedId);
    await this.recordEvent(project, 'feedback', 'create', 'feedback', String(savedId), row as unknown as Record<string, unknown>, host.id);
    await this.recordLog(host.id, 'project.feedback.create', { slug: project.slug, feedback_id: savedId });
    wsPublisher.publish('project.feedback.created', { slug: project.slug, feedback_id: savedId, source_host_id: host.id });
    return { project: project.slug, feedback: row };
  }

  async findBySlug(slug: string, includeArchived = false): Promise<ProjectRow | null> {
    const rows = await this.db
      .select()
      .from(coordProjects)
      .where(includeArchived ? eq(coordProjects.slug, slug) : and(eq(coordProjects.slug, slug), isNull(coordProjects.archivedAt)))
      .limit(1);
    return rows[0] ? this.hydrateProject(rows[0]) : null;
  }

  async findById(id: number): Promise<ProjectRow | null> {
    const rows = await this.db.select().from(coordProjects).where(eq(coordProjects.id, id)).limit(1);
    return rows[0] ? this.hydrateProject(rows[0]) : null;
  }

  async requireProject(slug: string): Promise<ProjectRow> {
    const normalized = this.normalizeSlug(slug);
    const found = await this.findBySlug(normalized);
    if (!found) throw new NotFoundError('Project not found');
    return found;
  }

  private async buildDetail(project: ProjectRow, host: Host, log: boolean) {
    const [notes, todos, files, feedback, recent] = await Promise.all([
      this.fetchNotes(project.id),
      this.fetchTodos(project.id),
      this.fetchFiles(project.id),
      this.fetchFeedback(project.id),
      this.fetchRecentEvents(project.id, 20),
    ]);
    if (log) await this.recordLog(host.id, 'project.detail', { slug: project.slug });
    return {
      project: {
        slug: project.slug,
        about: project.about,
        roster_markdown: project.roster_markdown ?? '',
        latest_seq: project.latest_event_seq,
        created_at: project.created_at,
        updated_at: project.updated_at,
        counts: {
          notes: notes.length,
          open_todos: todos.filter((t) => !t.done).length,
          done_todos: todos.filter((t) => t.done).length,
          files: files.length,
          feedback: feedback.length,
        },
      },
      notes,
      todos,
      files,
      feedback,
      recent_changes: recent,
    };
  }

  private async fetchNotes(projectId: number): Promise<NoteRow[]> {
    const rows = await this.db
      .select()
      .from(coordProjectNotes)
      .where(eq(coordProjectNotes.projectId, projectId))
      .orderBy(desc(coordProjectNotes.updatedAt), desc(coordProjectNotes.id));
    return rows.map((r) => this.hydrateNote(r));
  }

  private async fetchTodos(projectId: number): Promise<TodoRow[]> {
    const rows = await this.db
      .select()
      .from(coordProjectTodos)
      .where(eq(coordProjectTodos.projectId, projectId))
      .orderBy(desc(coordProjectTodos.updatedAt), desc(coordProjectTodos.id));
    return rows.map((r) => this.hydrateTodo(r));
  }

  private async fetchTodoById(projectId: number, id: number): Promise<TodoRow | null> {
    const rows = await this.db
      .select()
      .from(coordProjectTodos)
      .where(and(eq(coordProjectTodos.projectId, projectId), eq(coordProjectTodos.id, id)))
      .limit(1);
    return rows[0] ? this.hydrateTodo(rows[0]) : null;
  }

  private async fetchFiles(projectId: number): Promise<FileRow[]> {
    const rows = await this.db
      .select()
      .from(coordProjectFiles)
      .where(eq(coordProjectFiles.projectId, projectId))
      .orderBy(desc(coordProjectFiles.updatedAt), desc(coordProjectFiles.id));
    return rows.map((r) => this.hydrateFile(r));
  }

  private async fetchFileById(projectId: number, id: number): Promise<FileRow | null> {
    const rows = await this.db
      .select()
      .from(coordProjectFiles)
      .where(and(eq(coordProjectFiles.projectId, projectId), eq(coordProjectFiles.id, id)))
      .limit(1);
    return rows[0] ? this.hydrateFile(rows[0]) : null;
  }

  private async fetchFeedback(projectId: number): Promise<FeedbackRow[]> {
    const rows = await this.db
      .select()
      .from(coordProjectFeedback)
      .where(eq(coordProjectFeedback.projectId, projectId))
      .orderBy(desc(coordProjectFeedback.updatedAt), desc(coordProjectFeedback.id));
    return rows.map((r) => this.hydrateFeedback(r));
  }

  private async fetchFeedbackById(projectId: number, id: number): Promise<FeedbackRow | null> {
    const rows = await this.db
      .select()
      .from(coordProjectFeedback)
      .where(and(eq(coordProjectFeedback.projectId, projectId), eq(coordProjectFeedback.id, id)))
      .limit(1);
    return rows[0] ? this.hydrateFeedback(rows[0]) : null;
  }

  private async fetchRecentEvents(projectId: number, limit: number): Promise<EventRow[]> {
    const rows = await this.db
      .select()
      .from(coordProjectEvents)
      .where(eq(coordProjectEvents.projectId, projectId))
      .orderBy(desc(coordProjectEvents.seq))
      .limit(limit);
    return rows.map((r) => this.hydrateEvent(r));
  }

  private async recordEvent(
    project: ProjectRow,
    eventType: string,
    action: string,
    entityType: string | null,
    entityId: string | null,
    payload: Record<string, unknown> | null,
    sourceHostId: number | null,
  ): Promise<void> {
    if (project.id <= 0) throw new ConflictError('Project event requires a stored project');
    const seq = await this.nextEventSeq(project.id);
    const now = nowIso();
    await this.db.insert(coordProjectEvents).values({
      projectId: project.id,
      seq,
      eventType,
      action,
      entityType,
      entityId,
      payloadJson: payload,
      sourceHostId,
      createdAt: now,
    });
    wsPublisher.publish('project.changed', { slug: project.slug, seq, event_type: eventType, action, source_host_id: sourceHostId });
  }

  private async nextEventSeq(projectId: number): Promise<number> {
    const now = nowIso();
    await this.db.execute(
      sql`UPDATE coord_projects SET latest_event_seq = LAST_INSERT_ID(latest_event_seq + 1), updated_at = ${now} WHERE id = ${projectId}`,
    );
    const result = await this.db.execute(sql`SELECT LAST_INSERT_ID() AS seq`);
    const rows = Array.isArray(result) ? result[0] : result;
    const first = Array.isArray(rows) ? rows[0] : (rows as { seq?: number });
    const seq = first ? Number((first as { seq?: number }).seq ?? 0) : 0;
    if (seq <= 0) {
      const proj = await this.findById(projectId);
      return proj ? proj.latest_event_seq : 0;
    }
    return seq;
  }

  private async recordLog(hostId: number | null, action: string, details: Record<string, unknown>): Promise<void> {
    const now = nowIso();
    await this.db.insert(logs).values({
      hostId: hostId ?? null,
      action,
      details: JSON.stringify(details),
      createdAt: now,
      engine: null,
    });
  }

  private hydrateProject(row: typeof coordProjects.$inferSelect): ProjectRow {
    return {
      id: Number(row.id),
      slug: row.slug,
      about: (row.aboutJson as Record<string, unknown> | null) ?? null,
      roster_markdown: row.rosterMarkdown ?? '',
      latest_event_seq: Number(row.latestEventSeq ?? 0),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      archived_at: row.archivedAt ?? null,
    };
  }

  private hydrateNote(row: typeof coordProjectNotes.$inferSelect): NoteRow {
    return {
      id: Number(row.id),
      project_id: Number(row.projectId),
      header: row.header,
      body: row.body,
      source_host_id: row.sourceHostId ?? null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  private hydrateTodo(row: typeof coordProjectTodos.$inferSelect): TodoRow {
    return {
      id: Number(row.id),
      project_id: Number(row.projectId),
      title: row.title,
      detail: row.detail,
      done: Boolean(row.done),
      done_at: row.doneAt ?? null,
      source_host_id: row.sourceHostId ?? null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  private hydrateFile(row: typeof coordProjectFiles.$inferSelect): FileRow {
    const content = row.content ?? '';
    return {
      id: Number(row.id),
      project_id: Number(row.projectId),
      stored_name: row.storedName,
      description: row.description ?? null,
      content,
      content_sha256: row.contentSha256,
      mime_type: row.mimeType ?? null,
      size_bytes: Buffer.byteLength(content, 'utf8'),
      source_host_id: row.sourceHostId ?? null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  private hydrateFeedback(row: typeof coordProjectFeedback.$inferSelect): FeedbackRow {
    return {
      id: Number(row.id),
      project_id: Number(row.projectId),
      type: row.type,
      title: row.title,
      body: row.body,
      status: row.status,
      source_host_id: row.sourceHostId ?? null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  private hydrateEvent(row: typeof coordProjectEvents.$inferSelect): EventRow {
    return {
      seq: Number(row.seq),
      project_id: Number(row.projectId),
      event_type: row.eventType,
      action: row.action,
      entity_type: row.entityType ?? null,
      entity_id: row.entityId ?? null,
      payload: (row.payloadJson as Record<string, unknown> | null) ?? null,
      source_host_id: row.sourceHostId ?? null,
      created_at: row.createdAt,
    };
  }

  buildSummary(project: ProjectRow): ProjectSummary {
    const about = (project.about ?? {}) as Record<string, unknown>;
    const slug = project.slug;
    return {
      slug,
      title: this.optString(about['title']) ?? slug,
      name: this.optString(about['name']) ?? slug,
      description: this.optString(about['description']) ?? '',
      about: project.about,
      latest_seq: project.latest_event_seq,
      created_at: project.created_at,
      updated_at: project.updated_at,
    };
  }

  normalizeSlug(value: unknown): string {
    const slug = String(value ?? '').trim();
    if (slug === '') throw new ValidationError('Validation failed', { extra: { errors: { slug: ['slug is required'] } } });
    if (!SLUG_RE.test(slug)) {
      throw new ValidationError('Validation failed', {
        extra: { errors: { slug: ['slug must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/'] } },
      });
    }
    return slug;
  }

  normalizeAbout(value: unknown): Record<string, unknown> | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new ValidationError('Validation failed', { extra: { errors: { about: ['about must be an object'] } } });
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!k.trim()) continue;
      if (v === null || typeof v === 'boolean' || typeof v === 'number') {
        out[k] = v;
      } else if (typeof v === 'string') {
        out[k] = v.trim();
      } else if (typeof v === 'object') {
        out[k] = v;
      }
    }
    return Object.keys(out).length === 0 ? null : out;
  }

  normalizeRoster(value: unknown): string {
    const text = String(value ?? '').trim();
    if (text.length > 65535) {
      throw new ValidationError('Validation failed', { extra: { errors: { roster_markdown: ['roster_markdown must be 65535 characters or fewer'] } } });
    }
    return text;
  }

  normalizeNotePayload(payload: Record<string, unknown>): { header: string; body: string } {
    const header = String(payload['header'] ?? '').trim();
    const body = String(payload['body'] ?? '').trim();
    const errors: Record<string, string[]> = {};
    if (!header) errors['header'] = ['header is required'];
    if (!body) errors['body'] = ['body is required'];
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });
    return { header, body };
  }

  normalizeTodoPayload(payload: Record<string, unknown>): { title: string; detail: string } {
    const title = String(payload['title'] ?? '').trim();
    const detail = String(payload['detail'] ?? '').trim();
    if (!title) throw new ValidationError('Validation failed', { extra: { errors: { title: ['title is required'] } } });
    return { title, detail };
  }

  normalizeFilePayload(payload: Record<string, unknown>): {
    storedName: string;
    description: string | null;
    content: string;
    mimeType: string | null;
  } {
    const rawName = payload['stored_name'] ?? payload['name'] ?? '';
    const storedName = this.normalizeStoredName(rawName);
    const content = String(payload['content'] ?? payload['text'] ?? '');
    if (!content) throw new ValidationError('Validation failed', { extra: { errors: { content: ['content is required'] } } });
    return {
      storedName,
      description: this.optString(payload['description']),
      content,
      mimeType: this.optString(payload['mime_type']),
    };
  }

  normalizeStoredName(value: unknown): string {
    const name = String(value ?? '').trim();
    if (!name) throw new ValidationError('Validation failed', { extra: { errors: { stored_name: ['stored_name is required'] } } });
    if (!STORED_NAME_RE.test(name)) throw new ValidationError('Validation failed', { extra: { errors: { stored_name: ['stored_name is invalid'] } } });
    const normalized = name.replaceAll('\\', '/').replace(/\/+/g, '/');
    const segments = normalized.split('/').filter((s) => s !== '');
    if (segments.length === 0) throw new ValidationError('Validation failed', { extra: { errors: { stored_name: ['stored_name is invalid'] } } });
    for (const seg of segments) {
      if (seg === '.' || seg === '..') {
        throw new ValidationError('Validation failed', { extra: { errors: { stored_name: ['stored_name cannot contain dot segments'] } } });
      }
    }
    return segments.join('/');
  }

  normalizeFeedbackPayload(payload: Record<string, unknown>): { type: string; title: string; body: string } {
    const type = String(payload['type'] ?? 'feature').trim().toLowerCase();
    const title = String(payload['title'] ?? '').trim();
    const body = String(payload['body'] ?? '').trim();
    const errors: Record<string, string[]> = {};
    if (!FEEDBACK_TYPES.has(type)) errors['type'] = ['type must be bug, feature, or note'];
    if (!title) errors['title'] = ['title is required'];
    if (!body) errors['body'] = ['body is required'];
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });
    return { type, title, body };
  }

  private optString(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  }
}

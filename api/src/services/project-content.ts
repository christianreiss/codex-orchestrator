/**
 * Sub-resource handlers for a project: notes, todos, files, feedback.
 * Each method:
 *  - resolves the parent project by slug,
 *  - mutates the child row,
 *  - writes a `coord_project_events` audit row BEFORE publishing the WS event,
 *  - returns a snake_cased payload that mirrors the legacy PHP responses.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import {
  coordProjectFeedback,
  coordProjectFiles,
  coordProjectNotes,
  coordProjectTodos,
} from '../db/schema.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { ProjectsService, formatFile, type ProjectFileView, type TodoView } from './projects.js';
import { isProjectFeedbackType, projectFeedbackTypeList } from './project-feedback-types.js';

function trimStr(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const STORED_NAME_RE = /^[^\0]+$/;

function normalizeStoredName(value: unknown): string {
  let name = trimStr(value);
  if (name === '') {
    throw new ValidationError('stored_name is required', { param: 'stored_name' });
  }
  if (!STORED_NAME_RE.test(name)) {
    throw new ValidationError('stored_name is invalid', { param: 'stored_name' });
  }
  name = name.replace(/\\/g, '/');
  name = name.replace(/\/+/g, '/');
  const segments = name.split('/').filter((s) => s !== '');
  if (segments.length === 0) {
    throw new ValidationError('stored_name is invalid', { param: 'stored_name' });
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new ValidationError('stored_name cannot contain dot segments', { param: 'stored_name' });
    }
  }
  return segments.join('/');
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function normalizeNote(payload: Record<string, unknown>): { header: string; body: string } {
  const header = trimStr(payload.header);
  const body = trimStr(payload.body);
  const errors: string[] = [];
  if (header === '') errors.push('header is required');
  if (body === '') errors.push('body is required');
  if (errors.length > 0) throw new ValidationError(errors.join('; '), { param: header === '' ? 'header' : 'body' });
  return { header, body };
}

function normalizeTodo(payload: Record<string, unknown>): { title: string; detail: string } {
  const title = trimStr(payload.title);
  const detail = trimStr(payload.detail);
  if (title === '') throw new ValidationError('title is required', { param: 'title' });
  return { title, detail };
}

function normalizeFile(payload: Record<string, unknown>): { storedName: string; description: string | null; content: string; mimeType: string | null } {
  const storedName = normalizeStoredName(payload.stored_name ?? payload.name);
  const description = normalizeOptionalString(payload.description);
  const content = typeof payload.content === 'string' ? payload.content : typeof payload.text === 'string' ? payload.text : '';
  const mimeType = normalizeOptionalString(payload.mime_type);
  if (content === '') {
    throw new ValidationError('content is required', { param: 'content' });
  }
  return { storedName, description, content, mimeType };
}

function normalizeFeedback(payload: Record<string, unknown>): { type: string; title: string; body: string } {
  const type = trimStr(payload.type).toLowerCase() || 'feature';
  if (!isProjectFeedbackType(type)) {
    throw new ValidationError(`type must be one of: ${projectFeedbackTypeList()}`, { param: 'type' });
  }
  const title = trimStr(payload.title);
  const body = trimStr(payload.body);
  if (title === '') throw new ValidationError('title is required', { param: 'title' });
  if (body === '') throw new ValidationError('body is required', { param: 'body' });
  return { type, title, body };
}

export class ProjectContentService {
  constructor(
    private readonly db: Database,
    private readonly projects: ProjectsService,
  ) {}

  // ── notes ────────────────────────────────────────────────────────────────

  async listNotes(slug: string): Promise<{ project: string; notes: typeof coordProjectNotes.$inferSelect[] }> {
    const project = await this.projects._resolveProject(slug);
    const notes = await this.db
      .select()
      .from(coordProjectNotes)
      .where(eq(coordProjectNotes.projectId, project.id))
      .orderBy(desc(coordProjectNotes.updatedAt));
    return { project: project.slug, notes };
  }

  async upsertNote(
    slug: string,
    id: number | null,
    payload: Record<string, unknown>,
    sourceHostId: number | null = null,
  ): Promise<{ project: string; note: typeof coordProjectNotes.$inferSelect }> {
    const project = await this.projects._resolveProject(slug);
    const { header, body } = normalizeNote(payload);
    const nowTs = nowIso();

    let savedId: number;
    let action: 'create' | 'update';
    if (id === null) {
      const inserted = await this.db.insert(coordProjectNotes).values({
        projectId: project.id,
        header,
        body,
        sourceHostId,
        createdAt: nowTs,
        updatedAt: nowTs,
      }).$returningId();
      savedId = inserted[0]?.id ?? 0;
      action = 'create';
    } else {
      const existing = await this.db
        .select()
        .from(coordProjectNotes)
        .where(and(eq(coordProjectNotes.projectId, project.id), eq(coordProjectNotes.id, id)))
        .limit(1);
      if (!existing[0]) throw new NotFoundError('Note not found', 'note_not_found');
      await this.db
        .update(coordProjectNotes)
        .set({ header, body, sourceHostId, updatedAt: nowTs })
        .where(eq(coordProjectNotes.id, id));
      savedId = id;
      action = 'update';
    }

    const rows = await this.db
      .select()
      .from(coordProjectNotes)
      .where(eq(coordProjectNotes.id, savedId))
      .limit(1);
    const note = rows[0]!;

    await this.projects._recordEvent(project.id, 'note', action, 'note', savedId, { header, body }, sourceHostId);

    wsPublisher.publish(action === 'create' ? 'project.note.created' : 'project.note.updated', {
      slug: project.slug,
      note_id: savedId,
    });
    wsPublisher.publish('project.changed', { slug: project.slug });

    return { project: project.slug, note };
  }

  async deleteNote(slug: string, id: number, sourceHostId: number | null = null): Promise<{ project: string; deleted: number }> {
    const project = await this.projects._resolveProject(slug);
    const existing = await this.db
      .select({ id: coordProjectNotes.id })
      .from(coordProjectNotes)
      .where(and(eq(coordProjectNotes.projectId, project.id), eq(coordProjectNotes.id, id)))
      .limit(1);
    if (!existing[0]) throw new NotFoundError('Note not found', 'note_not_found');
    await this.db.delete(coordProjectNotes).where(eq(coordProjectNotes.id, id));
    await this.projects._recordEvent(project.id, 'note', 'delete', 'note', id, { id }, sourceHostId);
    wsPublisher.publish('project.note.deleted', { slug: project.slug, note_id: id });
    wsPublisher.publish('project.changed', { slug: project.slug });
    return { project: project.slug, deleted: id };
  }

  // ── todos ────────────────────────────────────────────────────────────────

  async listTodos(slug: string): Promise<{ project: string; todos: TodoView[] }> {
    const project = await this.projects._resolveProject(slug);
    const todos = await this.db
      .select()
      .from(coordProjectTodos)
      .where(eq(coordProjectTodos.projectId, project.id))
      .orderBy(desc(coordProjectTodos.updatedAt));
    const views: TodoView[] = todos.map((t) => ({ ...t, done: Boolean(t.done) }));
    return { project: project.slug, todos: views };
  }

  async createTodo(slug: string, payload: Record<string, unknown>, sourceHostId: number | null = null): Promise<{ project: string; todo: TodoView }> {
    const project = await this.projects._resolveProject(slug);
    const { title, detail } = normalizeTodo(payload);
    const nowTs = nowIso();
    const inserted = await this.db.insert(coordProjectTodos).values({
      projectId: project.id,
      title,
      detail,
      done: 0,
      doneAt: null,
      sourceHostId,
      createdAt: nowTs,
      updatedAt: nowTs,
    }).$returningId();
    const savedId = inserted[0]?.id ?? 0;
    const rows = await this.db.select().from(coordProjectTodos).where(eq(coordProjectTodos.id, savedId)).limit(1);
    const todo = rows[0]!;
    const view: TodoView = { ...todo, done: Boolean(todo.done) };

    await this.projects._recordEvent(project.id, 'todo', 'create', 'todo', savedId, { ...view }, sourceHostId);
    wsPublisher.publish('project.todo.created', { slug: project.slug, todo_id: savedId });
    wsPublisher.publish('project.changed', { slug: project.slug });
    return { project: project.slug, todo: view };
  }

  async updateTodo(slug: string, id: number, payload: Record<string, unknown>, sourceHostId: number | null = null): Promise<{ project: string; todo: TodoView }> {
    const project = await this.projects._resolveProject(slug);
    const { title, detail } = normalizeTodo(payload);
    const existing = await this.db
      .select()
      .from(coordProjectTodos)
      .where(and(eq(coordProjectTodos.projectId, project.id), eq(coordProjectTodos.id, id)))
      .limit(1);
    if (!existing[0]) throw new NotFoundError('Todo not found', 'todo_not_found');

    const nowTs = nowIso();
    await this.db
      .update(coordProjectTodos)
      .set({ title, detail, sourceHostId, updatedAt: nowTs })
      .where(eq(coordProjectTodos.id, id));
    const rows = await this.db.select().from(coordProjectTodos).where(eq(coordProjectTodos.id, id)).limit(1);
    const todo = rows[0]!;
    const view: TodoView = { ...todo, done: Boolean(todo.done) };

    await this.projects._recordEvent(project.id, 'todo', 'update', 'todo', id, { ...view }, sourceHostId);
    wsPublisher.publish('project.todo.updated', { slug: project.slug, todo_id: id });
    wsPublisher.publish('project.changed', { slug: project.slug });
    return { project: project.slug, todo: view };
  }

  async setTodoDone(slug: string, id: number, done: boolean, sourceHostId: number | null = null): Promise<{ project: string; todo: TodoView }> {
    const project = await this.projects._resolveProject(slug);
    const existing = await this.db
      .select()
      .from(coordProjectTodos)
      .where(and(eq(coordProjectTodos.projectId, project.id), eq(coordProjectTodos.id, id)))
      .limit(1);
    if (!existing[0]) throw new NotFoundError('Todo not found', 'todo_not_found');

    const nowTs = nowIso();
    await this.db
      .update(coordProjectTodos)
      .set({ done: done ? 1 : 0, doneAt: done ? nowTs : null, sourceHostId, updatedAt: nowTs })
      .where(eq(coordProjectTodos.id, id));
    const rows = await this.db.select().from(coordProjectTodos).where(eq(coordProjectTodos.id, id)).limit(1);
    const todo = rows[0]!;
    const view: TodoView = { ...todo, done: Boolean(todo.done) };

    await this.projects._recordEvent(project.id, 'todo', done ? 'mark_done' : 'mark_undone', 'todo', id, { ...view }, sourceHostId);
    wsPublisher.publish('project.todo.updated', { slug: project.slug, todo_id: id, done });
    wsPublisher.publish('project.changed', { slug: project.slug });
    return { project: project.slug, todo: view };
  }

  async deleteTodo(slug: string, id: number, sourceHostId: number | null = null): Promise<{ project: string; deleted: number }> {
    const project = await this.projects._resolveProject(slug);
    const existing = await this.db
      .select({ id: coordProjectTodos.id })
      .from(coordProjectTodos)
      .where(and(eq(coordProjectTodos.projectId, project.id), eq(coordProjectTodos.id, id)))
      .limit(1);
    if (!existing[0]) throw new NotFoundError('Todo not found', 'todo_not_found');
    await this.db.delete(coordProjectTodos).where(eq(coordProjectTodos.id, id));
    await this.projects._recordEvent(project.id, 'todo', 'delete', 'todo', id, { id }, sourceHostId);
    wsPublisher.publish('project.todo.deleted', { slug: project.slug, todo_id: id });
    wsPublisher.publish('project.changed', { slug: project.slug });
    return { project: project.slug, deleted: id };
  }

  // ── files ────────────────────────────────────────────────────────────────

  async listFiles(slug: string): Promise<{ project: string; files: ProjectFileView[] }> {
    const project = await this.projects._resolveProject(slug);
    const rows = await this.db
      .select()
      .from(coordProjectFiles)
      .where(eq(coordProjectFiles.projectId, project.id))
      .orderBy(asc(coordProjectFiles.storedName));
    return { project: project.slug, files: rows.map(formatFile) };
  }

  async upsertFile(slug: string, payload: Record<string, unknown>, sourceHostId: number | null = null): Promise<{ project: string; file: ProjectFileView }> {
    const project = await this.projects._resolveProject(slug);
    const { storedName, description, content, mimeType } = normalizeFile(payload);
    const sha = createHash('sha256').update(content).digest('hex');
    const nowTs = nowIso();

    const existing = await this.db
      .select()
      .from(coordProjectFiles)
      .where(and(eq(coordProjectFiles.projectId, project.id), eq(coordProjectFiles.storedName, storedName)))
      .limit(1);

    let savedId: number;
    let action: 'create' | 'update';
    if (existing[0]) {
      savedId = existing[0].id;
      action = 'update';
      await this.db
        .update(coordProjectFiles)
        .set({
          description,
          content,
          contentSha256: sha,
          mimeType,
          sourceHostId,
          updatedAt: nowTs,
        })
        .where(eq(coordProjectFiles.id, savedId));
    } else {
      const inserted = await this.db.insert(coordProjectFiles).values({
        projectId: project.id,
        storedName,
        description,
        content,
        contentSha256: sha,
        mimeType,
        sourceHostId,
        createdAt: nowTs,
        updatedAt: nowTs,
      }).$returningId();
      savedId = inserted[0]?.id ?? 0;
      action = 'create';
    }

    const rows = await this.db.select().from(coordProjectFiles).where(eq(coordProjectFiles.id, savedId)).limit(1);
    const file = formatFile(rows[0]!);

    await this.projects._recordEvent(project.id, 'file', action, 'file', savedId, {
      stored_name: storedName,
      description,
      content_sha256: sha,
      mime_type: mimeType,
    }, sourceHostId);

    wsPublisher.publish(action === 'create' ? 'project.file.upserted' : 'project.file.updated', {
      slug: project.slug,
      file_id: savedId,
      stored_name: storedName,
    });
    wsPublisher.publish('project.changed', { slug: project.slug });

    return { project: project.slug, file };
  }

  async deleteFile(slug: string, id: number, sourceHostId: number | null = null): Promise<{ project: string; deleted: number }> {
    const project = await this.projects._resolveProject(slug);
    const existing = await this.db
      .select({ id: coordProjectFiles.id, storedName: coordProjectFiles.storedName })
      .from(coordProjectFiles)
      .where(and(eq(coordProjectFiles.projectId, project.id), eq(coordProjectFiles.id, id)))
      .limit(1);
    if (!existing[0]) throw new NotFoundError('Project file not found', 'project_file_not_found');
    const storedName = existing[0].storedName;
    await this.db.delete(coordProjectFiles).where(eq(coordProjectFiles.id, id));
    await this.projects._recordEvent(project.id, 'file', 'delete', 'file', id, { id, stored_name: storedName }, sourceHostId);
    wsPublisher.publish('project.file.deleted', { slug: project.slug, file_id: id, stored_name: storedName });
    wsPublisher.publish('project.changed', { slug: project.slug });
    return { project: project.slug, deleted: id };
  }

  // ── feedback ─────────────────────────────────────────────────────────────

  async listFeedback(slug: string | null): Promise<{ project: string | null; feedback: typeof coordProjectFeedback.$inferSelect[] }> {
    if (slug === null) {
      const rows = await this.db.select().from(coordProjectFeedback).orderBy(desc(coordProjectFeedback.updatedAt));
      return { project: null, feedback: rows };
    }
    const project = await this.projects._resolveProject(slug);
    const rows = await this.db
      .select()
      .from(coordProjectFeedback)
      .where(eq(coordProjectFeedback.projectId, project.id))
      .orderBy(desc(coordProjectFeedback.updatedAt));
    return { project: project.slug, feedback: rows };
  }

  async createFeedback(slug: string, payload: Record<string, unknown>, sourceHostId: number | null = null): Promise<{ project: string; feedback: typeof coordProjectFeedback.$inferSelect }> {
    const project = await this.projects._resolveProject(slug);
    const { type, title, body } = normalizeFeedback(payload);
    const nowTs = nowIso();
    const inserted = await this.db.insert(coordProjectFeedback).values({
      projectId: project.id,
      type,
      title,
      body,
      status: 'open',
      sourceHostId,
      createdAt: nowTs,
      updatedAt: nowTs,
    }).$returningId();
    const savedId = inserted[0]?.id ?? 0;
    const rows = await this.db.select().from(coordProjectFeedback).where(eq(coordProjectFeedback.id, savedId)).limit(1);
    const feedback = rows[0]!;
    await this.projects._recordEvent(project.id, 'feedback', 'create', 'feedback', savedId, feedback, sourceHostId);
    wsPublisher.publish('project.feedback.created', { slug: project.slug, feedback_id: savedId, type });
    wsPublisher.publish('project.changed', { slug: project.slug });
    return { project: project.slug, feedback };
  }
}

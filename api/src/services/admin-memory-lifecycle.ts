import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  adminEvents,
  coordProjectEvents,
  coordProjectMemories,
  coordProjects,
  hosts,
  logs,
  mcpMemories,
  sharedMemories,
  sharedMemoryChunks,
  sharedMemoryRevisions,
} from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { isEngine } from '../util/engine.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { MAX_CONTENT_CHARS, SharedMemoriesService } from './shared-memories.js';
import { AdminMemoryCatalog } from './admin-memory-catalog.js';
import {
  assertEtag,
  etagForRow,
  hasOwn,
  isDuplicateError,
  memoryNodeId,
  normalizeContent,
  normalizeEngine,
  normalizeMemoryKey,
  normalizeMetadata,
  normalizeNullableText,
  normalizePositiveInt,
  normalizeSharedSlug,
  normalizeTags,
  readInsertId,
  sameValue,
  toMemoryDetail,
  type AuditPayload,
  type MemoryDetail,
  type MemoryScope,
  type UnifiedMemoryRow,
} from './admin-memory-model.js';

export class AdminMemoryLifecycle {
  constructor(private readonly db: Database) {}

  async create(
    scope: MemoryScope,
    input: Record<string, unknown>,
    actorId: number,
  ): Promise<{ status: 'created'; memory: MemoryDetail }> {
    this.assertCreateInput(scope, input);
    try {
      if (scope === 'host') return await this.createHost(input, actorId);
      if (scope === 'project') return await this.createProject(input, actorId);
      return await this.createShared(input, actorId);
    } catch (error) {
      if (isDuplicateError(error)) throw new ConflictError('Memory already exists', 'memory_conflict');
      throw error;
    }
  }

  async update(
    scope: MemoryScope,
    recordId: number,
    input: Record<string, unknown>,
    actorId: number,
  ): Promise<{ status: 'updated' | 'unchanged'; memory: MemoryDetail }> {
    this.assertMutablePatch(scope, input);
    if (scope === 'host') return this.updateHost(recordId, input, actorId);
    if (scope === 'project') return this.updateProject(recordId, input, actorId);
    return this.updateShared(recordId, input, actorId);
  }

  async remove(
    scope: MemoryScope,
    recordId: number,
    expectedEtag: unknown,
    actorId: number,
  ): Promise<{ status: 'deleted'; node_id: string; scope: MemoryScope; record_id: number }> {
    const deleted = await this.db.transaction(async (tx) => {
      const scoped = new AdminMemoryCatalog(tx as unknown as Database);
      const initial = await scoped.loadRow(scope, recordId);
      if (!initial) throw new NotFoundError('Memory not found', 'memory_not_found');

      if (scope === 'project') {
        await tx
          .select({ id: coordProjects.id })
          .from(coordProjects)
          .where(eq(coordProjects.id, initial.projectId!))
          .for('update');
      }
      await this.lockRecord(tx as unknown as Database, scope, recordId);
      const row = await scoped.loadRow(scope, recordId);
      if (!row) throw new NotFoundError('Memory not found', 'memory_not_found');
      assertEtag(expectedEtag, row);

      if (scope === 'host') {
        await tx.delete(mcpMemories).where(eq(mcpMemories.id, recordId));
      } else if (scope === 'project') {
        await tx.delete(coordProjectMemories).where(eq(coordProjectMemories.id, recordId));
        await this.recordProjectEvent(tx as unknown as Database, row, 'delete');
      } else {
        await tx.delete(sharedMemoryChunks).where(eq(sharedMemoryChunks.memoryId, recordId));
        await tx.delete(sharedMemoryRevisions).where(eq(sharedMemoryRevisions.memoryId, recordId));
        await tx.delete(sharedMemories).where(eq(sharedMemories.id, recordId));
      }
      await this.writeAudit(tx as unknown as Database, 'deleted', actorId, row, null);
      return row;
    });

    this.publishMutation('deleted', deleted);
    return { status: 'deleted', node_id: memoryNodeId(scope, recordId), scope, record_id: recordId };
  }

  async appendShared(
    recordId: number,
    contentValue: unknown,
    actorId: number,
  ): Promise<{ status: 'appended'; memory: MemoryDetail }> {
    const addition = normalizeContent(contentValue, MAX_CONTENT_CHARS);
    const result = await this.db.transaction(async (tx) => {
      await tx
        .select({ id: sharedMemories.id })
        .from(sharedMemories)
        .where(eq(sharedMemories.id, recordId))
        .for('update');
      const scoped = new AdminMemoryCatalog(tx as unknown as Database);
      const before = await scoped.loadRow('shared', recordId);
      if (!before) throw new NotFoundError('Memory not found', 'memory_not_found');
      const shared = new SharedMemoriesService(tx as unknown as Database, { publishEvents: false });
      await shared.appendAlreadyLocked(
        { slug: before.key, content: addition },
        null,
        isEngine(before.engine) ? before.engine : null,
      );
      const after = await scoped.loadRow('shared', recordId);
      if (!after) throw new NotFoundError('Memory not found', 'memory_not_found');
      await this.writeAudit(tx as unknown as Database, 'appended', actorId, before, after);
      return { before, after };
    });
    this.publishMutation('appended', result.after);
    return { status: 'appended', memory: toMemoryDetail(result.after, true) };
  }

  private async createHost(
    input: Record<string, unknown>,
    actorId: number,
  ): Promise<{ status: 'created'; memory: MemoryDetail }> {
    const hostId = normalizePositiveInt(input['host_id'], 'host_id');
    const key = normalizeMemoryKey(input['id'] ?? input['key'], 'host');
    const content = normalizeContent(input['content'], 32_000);
    const metadata = normalizeMetadata(input['metadata']);
    const tags = normalizeTags(input['tags']);
    const summary = normalizeNullableText(input['summary'], 'summary', 1000);
    const engine = normalizeEngine(input['engine']);
    const row = await this.db.transaction(async (tx) => {
      const hostRows = await tx
        .select({ id: hosts.id })
        .from(hosts)
        .where(eq(hosts.id, hostId))
        .for('update');
      if (!hostRows[0]) throw new NotFoundError('Host not found', 'host_not_found');
      const existing = await tx
        .select()
        .from(mcpMemories)
        .where(and(eq(mcpMemories.hostId, hostId), eq(mcpMemories.memoryKey, key)))
        .for('update');
      if (existing[0] && existing[0].deletedAt === null)
        throw new ConflictError('Memory already exists', 'memory_conflict');
      const now = nowIso();
      let id = existing[0] ? Number(existing[0].id) : null;
      if (id !== null) {
        await tx
          .update(mcpMemories)
          .set({
            content,
            metadata,
            tags: tags.length ? tags : null,
            tagsText: tags.length ? tags.join(' ') : null,
            summary,
            engine,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          })
          .where(eq(mcpMemories.id, id));
      } else {
        const inserted = await tx.insert(mcpMemories).values({
          hostId,
          memoryKey: key,
          content,
          metadata,
          tags: tags.length ? tags : null,
          tagsText: tags.length ? tags.join(' ') : null,
          summary,
          engine,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
        id = readInsertId(inserted);
      }
      if (!id) {
        const saved = await tx
          .select({ id: mcpMemories.id })
          .from(mcpMemories)
          .where(and(eq(mcpMemories.hostId, hostId), eq(mcpMemories.memoryKey, key)))
          .limit(1);
        id = saved[0] ? Number(saved[0].id) : null;
      }
      if (!id) throw new Error('host memory insert did not persist');
      const scoped = new AdminMemoryCatalog(tx as unknown as Database);
      const saved = await scoped.loadRow('host', id);
      if (!saved) throw new Error('host memory insert did not persist');
      await this.writeAudit(tx as unknown as Database, 'created', actorId, null, saved);
      return saved;
    });
    this.publishMutation('created', row);
    return { status: 'created', memory: toMemoryDetail(row, true) };
  }

  private async createProject(
    input: Record<string, unknown>,
    actorId: number,
  ): Promise<{ status: 'created'; memory: MemoryDetail }> {
    const projectSlug = typeof input['project_slug'] === 'string' ? input['project_slug'].trim() : '';
    if (!projectSlug) throw new ValidationError('project_slug is required', { param: 'project_slug' });
    const key = normalizeMemoryKey(input['id'] ?? input['key'], 'project');
    const content = normalizeContent(input['content'], 32_000);
    const metadata = normalizeMetadata(input['metadata']);
    const tags = normalizeTags(input['tags']);
    const row = await this.db.transaction(async (tx) => {
      const projectRows = await tx
        .select()
        .from(coordProjects)
        .where(eq(coordProjects.slug, projectSlug))
        .for('update');
      const project = projectRows[0];
      if (!project) throw new NotFoundError('Project not found', 'project_not_found');
      const existing = await tx
        .select({ id: coordProjectMemories.id })
        .from(coordProjectMemories)
        .where(and(eq(coordProjectMemories.projectId, project.id), eq(coordProjectMemories.memoryKey, key)))
        .for('update');
      if (existing[0]) throw new ConflictError('Memory already exists', 'memory_conflict');
      const now = nowIso();
      const inserted = await tx.insert(coordProjectMemories).values({
        projectId: project.id,
        memoryKey: key,
        content,
        metadata,
        tags: tags.length ? tags : null,
        tagsText: tags.length ? tags.join(' ') : null,
        sourceHostId: null,
        createdAt: now,
        updatedAt: now,
      });
      let id = readInsertId(inserted);
      if (!id) {
        const saved = await tx
          .select({ id: coordProjectMemories.id })
          .from(coordProjectMemories)
          .where(and(eq(coordProjectMemories.projectId, project.id), eq(coordProjectMemories.memoryKey, key)))
          .limit(1);
        id = saved[0] ? Number(saved[0].id) : null;
      }
      if (!id) throw new Error('project memory insert did not persist');
      const scoped = new AdminMemoryCatalog(tx as unknown as Database);
      const saved = await scoped.loadRow('project', id);
      if (!saved) throw new Error('project memory insert did not persist');
      await this.recordProjectEvent(tx as unknown as Database, saved, 'create');
      await this.writeAudit(tx as unknown as Database, 'created', actorId, null, saved);
      return saved;
    });
    this.publishMutation('created', row);
    return { status: 'created', memory: toMemoryDetail(row, true) };
  }

  private async createShared(
    input: Record<string, unknown>,
    actorId: number,
  ): Promise<{ status: 'created'; memory: MemoryDetail }> {
    const slug = normalizeSharedSlug(input['id'] ?? input['slug'] ?? input['key']);
    const content = normalizeContent(input['content'], MAX_CONTENT_CHARS);
    const engine = normalizeEngine(input['engine']);
    const writePayload: Record<string, unknown> = { slug, content };
    for (const field of ['title', 'summary', 'metadata', 'tags'] as const)
      if (hasOwn(input, field)) writePayload[field] = input[field];
    const row = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(sharedMemories)
        .where(eq(sharedMemories.slug, slug))
        .for('update');
      if (existing[0] && existing[0].deletedAt === null)
        throw new ConflictError('Memory already exists', 'memory_conflict');
      const shared = new SharedMemoriesService(tx as unknown as Database, { publishEvents: false });
      await shared.write(writePayload, null, engine);
      const savedRows = await tx
        .select({ id: sharedMemories.id })
        .from(sharedMemories)
        .where(and(eq(sharedMemories.slug, slug), isNull(sharedMemories.deletedAt)))
        .limit(1);
      if (!savedRows[0]) throw new Error('shared memory insert did not persist');
      const scoped = new AdminMemoryCatalog(tx as unknown as Database);
      const saved = await scoped.loadRow('shared', Number(savedRows[0].id));
      if (!saved) throw new Error('shared memory insert did not persist');
      await this.writeAudit(tx as unknown as Database, 'created', actorId, null, saved);
      return saved;
    });
    this.publishMutation('created', row);
    return { status: 'created', memory: toMemoryDetail(row, true) };
  }

  private async updateHost(
    recordId: number,
    input: Record<string, unknown>,
    actorId: number,
  ): Promise<{ status: 'updated' | 'unchanged'; memory: MemoryDetail }> {
    const result = await this.db.transaction(async (tx) => {
      await tx
        .select({ id: mcpMemories.id })
        .from(mcpMemories)
        .where(eq(mcpMemories.id, recordId))
        .for('update');
      const scoped = new AdminMemoryCatalog(tx as unknown as Database);
      const before = await scoped.loadRow('host', recordId);
      if (!before) throw new NotFoundError('Memory not found', 'memory_not_found');
      assertEtag(input['expected_etag'], before);
      const next = {
        content: hasOwn(input, 'content') ? normalizeContent(input['content'], 32_000) : before.content,
        metadata: hasOwn(input, 'metadata') ? normalizeMetadata(input['metadata']) : before.metadata,
        tags: hasOwn(input, 'tags') ? normalizeTags(input['tags']) : before.tags,
        summary: hasOwn(input, 'summary')
          ? normalizeNullableText(input['summary'], 'summary', 1000)
          : before.summary,
        engine: hasOwn(input, 'engine') ? normalizeEngine(input['engine']) : before.engine,
      };
      if (
        sameValue(next, {
          content: before.content,
          metadata: before.metadata,
          tags: before.tags,
          summary: before.summary,
          engine: before.engine,
        })
      )
        return { changed: false, row: before };
      await tx
        .update(mcpMemories)
        .set({
          content: next.content,
          metadata: next.metadata,
          tags: next.tags.length ? next.tags : null,
          tagsText: next.tags.length ? next.tags.join(' ') : null,
          summary: next.summary,
          engine: next.engine,
          updatedAt: nowIso(),
        })
        .where(eq(mcpMemories.id, recordId));
      const after = await scoped.loadRow('host', recordId);
      if (!after) throw new NotFoundError('Memory not found', 'memory_not_found');
      await this.writeAudit(tx as unknown as Database, 'updated', actorId, before, after);
      return { changed: true, row: after };
    });
    if (result.changed) this.publishMutation('updated', result.row);
    return { status: result.changed ? 'updated' : 'unchanged', memory: toMemoryDetail(result.row, true) };
  }

  private async updateProject(
    recordId: number,
    input: Record<string, unknown>,
    actorId: number,
  ): Promise<{ status: 'updated' | 'unchanged'; memory: MemoryDetail }> {
    const result = await this.db.transaction(async (tx) => {
      const initialRows = await tx
        .select({ projectId: coordProjectMemories.projectId })
        .from(coordProjectMemories)
        .where(eq(coordProjectMemories.id, recordId))
        .limit(1);
      if (!initialRows[0]) throw new NotFoundError('Memory not found', 'memory_not_found');
      await tx
        .select({ id: coordProjects.id })
        .from(coordProjects)
        .where(eq(coordProjects.id, initialRows[0].projectId))
        .for('update');
      await tx
        .select({ id: coordProjectMemories.id })
        .from(coordProjectMemories)
        .where(eq(coordProjectMemories.id, recordId))
        .for('update');
      const scoped = new AdminMemoryCatalog(tx as unknown as Database);
      const before = await scoped.loadRow('project', recordId);
      if (!before) throw new NotFoundError('Memory not found', 'memory_not_found');
      assertEtag(input['expected_etag'], before);
      const next = {
        content: hasOwn(input, 'content') ? normalizeContent(input['content'], 32_000) : before.content,
        metadata: hasOwn(input, 'metadata') ? normalizeMetadata(input['metadata']) : before.metadata,
        tags: hasOwn(input, 'tags') ? normalizeTags(input['tags']) : before.tags,
      };
      if (sameValue(next, { content: before.content, metadata: before.metadata, tags: before.tags }))
        return { changed: false, row: before };
      await tx
        .update(coordProjectMemories)
        .set({
          content: next.content,
          metadata: next.metadata,
          tags: next.tags.length ? next.tags : null,
          tagsText: next.tags.length ? next.tags.join(' ') : null,
          sourceHostId: null,
          updatedAt: nowIso(),
        })
        .where(eq(coordProjectMemories.id, recordId));
      const after = await scoped.loadRow('project', recordId);
      if (!after) throw new NotFoundError('Memory not found', 'memory_not_found');
      await this.recordProjectEvent(tx as unknown as Database, after, 'update');
      await this.writeAudit(tx as unknown as Database, 'updated', actorId, before, after);
      return { changed: true, row: after };
    });
    if (result.changed) this.publishMutation('updated', result.row);
    return { status: result.changed ? 'updated' : 'unchanged', memory: toMemoryDetail(result.row, true) };
  }

  private async updateShared(
    recordId: number,
    input: Record<string, unknown>,
    actorId: number,
  ): Promise<{ status: 'updated' | 'unchanged'; memory: MemoryDetail }> {
    const result = await this.db.transaction(async (tx) => {
      await tx
        .select({ id: sharedMemories.id })
        .from(sharedMemories)
        .where(eq(sharedMemories.id, recordId))
        .for('update');
      const scoped = new AdminMemoryCatalog(tx as unknown as Database);
      const before = await scoped.loadRow('shared', recordId);
      if (!before) throw new NotFoundError('Memory not found', 'memory_not_found');
      assertEtag(input['expected_etag'], before);
      const next = {
        content: hasOwn(input, 'content')
          ? normalizeContent(input['content'], MAX_CONTENT_CHARS)
          : before.content,
        metadata: hasOwn(input, 'metadata') ? normalizeMetadata(input['metadata']) : before.metadata,
        tags: hasOwn(input, 'tags') ? normalizeTags(input['tags']) : before.tags,
        summary: hasOwn(input, 'summary')
          ? normalizeNullableText(input['summary'], 'summary', 1000)
          : before.summary,
        title: hasOwn(input, 'title')
          ? (normalizeNullableText(input['title'], 'title', 255) ?? before.key)
          : before.title,
        engine: hasOwn(input, 'engine') ? normalizeEngine(input['engine']) : before.engine,
      };
      if (
        sameValue(next, {
          content: before.content,
          metadata: before.metadata,
          tags: before.tags,
          summary: before.summary,
          title: before.title,
          engine: before.engine,
        })
      )
        return { changed: false, row: before };

      const documentChanged = !sameValue(
        {
          content: next.content,
          metadata: next.metadata,
          tags: next.tags,
          summary: next.summary,
          title: next.title,
        },
        {
          content: before.content,
          metadata: before.metadata,
          tags: before.tags,
          summary: before.summary,
          title: before.title,
        },
      );
      if (documentChanged) {
        const shared = new SharedMemoriesService(tx as unknown as Database, { publishEvents: false });
        await shared.write(
          {
            slug: before.key,
            content: next.content,
            metadata: next.metadata,
            tags: next.tags,
            summary: next.summary,
            title: next.title,
          },
          null,
          isEngine(next.engine) ? next.engine : null,
        );
      } else {
        await tx
          .update(sharedMemories)
          .set({ sourceEngine: next.engine, updatedAt: nowIso() })
          .where(eq(sharedMemories.id, recordId));
      }
      const after = await scoped.loadRow('shared', recordId);
      if (!after) throw new NotFoundError('Memory not found', 'memory_not_found');
      await this.writeAudit(tx as unknown as Database, 'updated', actorId, before, after);
      return { changed: true, row: after };
    });
    if (result.changed) this.publishMutation('updated', result.row);
    return { status: result.changed ? 'updated' : 'unchanged', memory: toMemoryDetail(result.row, true) };
  }

  private assertMutablePatch(scope: MemoryScope, input: Record<string, unknown>): void {
    for (const field of [
      'id',
      'key',
      'slug',
      'node_id',
      'record_id',
      'scope',
      'host_id',
      'project_id',
      'project_slug',
    ]) {
      if (hasOwn(input, field)) throw new ValidationError(`${field} is immutable`, { param: field });
    }
    const allowed =
      scope === 'host'
        ? ['content', 'metadata', 'tags', 'summary', 'engine']
        : scope === 'project'
          ? ['content', 'metadata', 'tags']
          : ['content', 'metadata', 'tags', 'summary', 'title', 'engine'];
    const supplied = allowed.some((field) => hasOwn(input, field));
    if (!supplied) throw new ValidationError('At least one mutable field is required', { param: 'body' });
    for (const key of Object.keys(input)) {
      if (key !== 'expected_etag' && !allowed.includes(key))
        throw new ValidationError(`Unknown or immutable field: ${key}`, { param: key });
    }
  }

  private assertCreateInput(scope: MemoryScope, input: Record<string, unknown>): void {
    const allowed =
      scope === 'host'
        ? ['id', 'key', 'host_id', 'content', 'metadata', 'tags', 'summary', 'engine']
        : scope === 'project'
          ? ['id', 'key', 'project_slug', 'content', 'metadata', 'tags']
          : ['id', 'key', 'slug', 'content', 'title', 'summary', 'metadata', 'tags', 'engine'];
    for (const key of Object.keys(input)) {
      if (!allowed.includes(key))
        throw new ValidationError(`Unknown field for ${scope} memory: ${key}`, { param: key });
    }
    const identityFields = scope === 'shared' ? ['id', 'key', 'slug'] : ['id', 'key'];
    const identities = identityFields
      .filter(
        (field) =>
          hasOwn(input, field) && typeof input[field] === 'string' && String(input[field]).trim() !== '',
      )
      .map((field) =>
        scope === 'shared' ? String(input[field]).trim().toLowerCase() : String(input[field]).trim(),
      );
    if (new Set(identities).size > 1) {
      throw new ValidationError('Memory identity aliases must match', { param: 'id' });
    }
  }

  private async lockRecord(db: Database, scope: MemoryScope, recordId: number): Promise<void> {
    if (scope === 'host')
      await db
        .select({ id: mcpMemories.id })
        .from(mcpMemories)
        .where(eq(mcpMemories.id, recordId))
        .for('update');
    else if (scope === 'project')
      await db
        .select({ id: coordProjectMemories.id })
        .from(coordProjectMemories)
        .where(eq(coordProjectMemories.id, recordId))
        .for('update');
    else
      await db
        .select({ id: sharedMemories.id })
        .from(sharedMemories)
        .where(eq(sharedMemories.id, recordId))
        .for('update');
  }

  private async recordProjectEvent(
    db: Database,
    row: UnifiedMemoryRow,
    action: 'create' | 'update' | 'delete',
  ): Promise<void> {
    if (!row.projectId || !row.projectSlug) return;
    const projectRows = await db
      .select({ seq: coordProjects.latestEventSeq })
      .from(coordProjects)
      .where(eq(coordProjects.id, row.projectId))
      .limit(1);
    if (!projectRows[0]) throw new NotFoundError('Project not found', 'project_not_found');
    const nextSeq = Number(projectRows[0].seq ?? 0) + 1;
    const now = nowIso();
    await db
      .update(coordProjects)
      .set({ latestEventSeq: nextSeq, updatedAt: now })
      .where(eq(coordProjects.id, row.projectId));
    await db.insert(coordProjectEvents).values({
      projectId: row.projectId,
      seq: nextSeq,
      eventType: 'memory',
      action,
      entityType: 'memory',
      entityId: String(row.recordId),
      payloadJson: {
        id: row.recordId,
        key: row.key,
        tags: row.tags,
        content_length: row.contentLength,
        updated_at: row.updatedAt,
      },
      sourceHostId: null,
      createdAt: now,
    });
  }

  private async writeAudit(
    db: Database,
    action: 'created' | 'updated' | 'deleted' | 'appended',
    actorId: number,
    before: UnifiedMemoryRow | null,
    after: UnifiedMemoryRow | null,
  ): Promise<void> {
    const row = after ?? before;
    if (!row) return;
    const payload: AuditPayload = {
      actor_id: actorId,
      node_id: memoryNodeId(row.scope, row.recordId),
      scope: row.scope,
      record_id: row.recordId,
      memory_id: row.key,
      old_etag: before ? etagForRow(before) : null,
      new_etag: after ? etagForRow(after) : null,
      old_content_length: before?.contentLength ?? null,
      content_length: after?.contentLength ?? null,
      old_tag_count: before?.tags.length ?? null,
      tag_count: after?.tags.length ?? null,
      project_id: row.projectId,
      project_slug: row.projectSlug,
      host_id: row.ownerHostId,
    };
    const createdAt = nowIso();
    await db
      .insert(adminEvents)
      .values({ type: `admin.memory.${action}`, hostId: row.ownerHostId, payload, createdAt });
    await db.insert(logs).values({
      hostId: row.ownerHostId,
      action: `admin.memory.${action}`,
      details: JSON.stringify(payload),
      engine: null,
      createdAt,
    });
  }

  private publishMutation(
    action: 'created' | 'updated' | 'deleted' | 'appended',
    row: UnifiedMemoryRow,
  ): void {
    const payload = {
      node_id: memoryNodeId(row.scope, row.recordId),
      scope: row.scope,
      record_id: row.recordId,
      id: row.key,
      host_id: row.ownerHostId,
      project_slug: row.projectSlug,
    };
    if (row.scope === 'shared') {
      wsPublisher.publish(
        action === 'created'
          ? 'shared_memory.created'
          : action === 'deleted'
            ? 'shared_memory.deleted'
            : 'shared_memory.changed',
        payload,
      );
    }
    if (row.scope === 'project') {
      wsPublisher.publish(
        action === 'created'
          ? 'project.memory.created'
          : action === 'deleted'
            ? 'project.memory.deleted'
            : 'project.memory.updated',
        payload,
      );
      wsPublisher.publish('project.changed', payload);
    }
    wsPublisher.publish(
      action === 'created' ? 'memory.created' : action === 'deleted' ? 'memory.deleted' : 'memory.changed',
      payload,
    );
  }
}

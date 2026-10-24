import { persistAuditLog } from './audit-log.js';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mcpMemories,
  coordProjectMemories,
  sharedMemories,
  sharedMemoryChunks,
  sharedMemoryRevisions,
} from '../db/schema.js';
import {
  mutateOwnerState,
  requireOwnerRuntime,
  type OwnerMutationContext,
} from '../control-plane/state/runtime.js';
import { stageUpdate, stageDelete } from '../control-plane/state/rows.js';
import { stageProjectEvent } from '../control-plane/state/projects.js';
import { adminAudit } from '../control-plane/state/admin.js';
import type { Json } from '../control-plane/commands.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { isEngine } from '../util/engine.js';
import { AdminMemoryCatalog } from './admin-memory-catalog.js';
import { SharedMemoriesService, MAX_CONTENT_CHARS } from './shared-memories.js';
import {
  assertEtag,
  etagForRow,
  hasOwn,
  memoryNodeId,
  normalizeContent,
  normalizeEngine,
  normalizeMemoryKey,
  normalizeMetadata,
  normalizeNullableText,
  normalizePositiveInt,
  normalizeSharedSlug,
  normalizeTags,
  sameValue,
  type MemoryScope,
  type UnifiedMemoryRow,
} from './admin-memory-model.js';

type Action = 'created' | 'updated' | 'deleted' | 'appended' | 'restored';
/** Admin content commands share one draft, transaction, ETag check and audit. */
export class AdminMemoryOwned {
  constructor(private readonly db: Database) {}
  private row(ctx: OwnerMutationContext, scope: MemoryScope, id: number, content: string): UnifiedMemoryRow {
    const base = {
      scope,
      recordId: id,
      content,
      contentLength: content.length,
      preview: content.slice(0, 280),
      ownerHostId: null,
      ownerHost: null,
      projectId: null,
      projectSlug: null,
      sourceHostId: null,
      sourceHost: null,
      engine: null,
      revision: null,
    };
    if (scope === 'host') {
      const r = ctx.draft.table('mcpMemories').get(id)!;
      return {
        ...base,
        key: r.memoryKey,
        title: r.memoryKey,
        summary: r.summary,
        metadata: r.metadata as Record<string, unknown> | null,
        tags: normalizeTags(r.tags),
        ownerHostId: r.hostId,
        ownerHost: ctx.draft.table('hosts').get(r.hostId)?.fqdn ?? null,
        engine: r.engine,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    }
    if (scope === 'project') {
      const r = ctx.draft.table('coordProjectMemories').get(id)!;
      return {
        ...base,
        key: r.memoryKey,
        title: r.memoryKey,
        summary: null,
        metadata: r.metadata as Record<string, unknown> | null,
        tags: normalizeTags(r.tags),
        projectId: r.projectId,
        projectSlug: ctx.draft.table('coordProjects').get(r.projectId)?.slug ?? null,
        sourceHostId: r.sourceHostId,
        sourceHost: r.sourceHostId ? (ctx.draft.table('hosts').get(r.sourceHostId)?.fqdn ?? null) : null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    }
    const r = ctx.draft.table('sharedMemories').get(id)!;
    return {
      ...base,
      key: r.slug,
      title: r.title,
      summary: r.summary,
      metadata: r.metadata as Record<string, unknown> | null,
      tags: normalizeTags(r.tags),
      sourceHostId: r.sourceHostId,
      sourceHost: r.sourceHostId ? (ctx.draft.table('hosts').get(r.sourceHostId)?.fqdn ?? null) : null,
      engine: r.sourceEngine,
      revision: r.revision,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
  private audit(
    ctx: OwnerMutationContext,
    action: Action,
    actor: number,
    before: UnifiedMemoryRow | null,
    after: UnifiedMemoryRow | null,
  ) {
    const row = after ?? before!;
    const payload = {
      actor_id: actor,
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
    adminAudit(ctx, 'admin.memory.' + action, payload, nowIso(), row.ownerHostId);
    ctx.write(async (tx) =>
      persistAuditLog(tx, {
        hostId: row.ownerHostId,
        action: 'admin.memory.' + action,
        details: JSON.stringify(payload),
        engine: null,
        createdAt: nowIso(),
      }),
    );
    if (row.scope === 'project')
      stageProjectEvent(
        ctx,
        row.projectId!,
        'memory',
        action === 'created' ? 'create' : action === 'deleted' ? 'delete' : 'update',
        'memory',
        row.recordId,
        {
          id: row.recordId,
          key: row.key,
          tags: row.tags,
          content_length: row.contentLength,
          updated_at: row.updatedAt,
        },
        null,
      );
  }
  async create(scope: MemoryScope, input: Record<string, unknown>, actor: number): Promise<UnifiedMemoryRow> {
    let saved!: UnifiedMemoryRow;
    await mutateOwnerState(requireOwnerRuntime(this.db), {
      kind: 'admin.memory.create',
      payload: { scope, actor },
      prepare: async (ctx) => {
        const key =
            scope === 'shared'
              ? normalizeSharedSlug(input.id ?? input.slug ?? input.key)
              : normalizeMemoryKey(input.id ?? input.key, scope),
          content = normalizeContent(input.content, scope === 'shared' ? MAX_CONTENT_CHARS : 32000),
          tags = normalizeTags(input.tags),
          metadata = normalizeMetadata(input.metadata),
          now = nowIso();
        if (scope === 'shared') {
          if (
            ctx.draft
              .table('sharedMemories')
              .all()
              .some((r) => r.slug === key && !r.deletedAt)
          )
            throw new ConflictError('Memory already exists', 'memory_conflict');
          await new SharedMemoriesService(this.db, { publishEvents: false, ownerContext: ctx }).write(
            { ...input, slug: key, content },
            null,
            normalizeEngine(input.engine),
          );
          ctx.write(async () => {
            const row = ctx.draft.table('sharedMemories').by('slug', key)[0]!;
            saved = this.row(ctx, scope, row.id, content);
            this.audit(ctx, 'created', actor, null, saved);
          });
        } else if (scope === 'host') {
          const hostId = normalizePositiveInt(input.host_id, 'host_id');
          if (!ctx.snapshot.hosts.has(hostId)) throw new NotFoundError('Host not found', 'host_not_found');
          const old = ctx.draft
            .table('mcpMemories')
            .all()
            .find((r) => r.hostId === hostId && r.memoryKey === key);
          if (old && !old.deletedAt) throw new ConflictError('Memory already exists', 'memory_conflict');
          const values = {
            hostId,
            memoryKey: key,
            content,
            metadata,
            tags: tags.length ? tags : null,
            tagsText: tags.length ? tags.join(' ') : null,
            summary: normalizeNullableText(input.summary, 'summary', 1000),
            engine: normalizeEngine(input.engine),
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          };
          if (old) {
            stageUpdate(ctx, 'mcpMemories', old.id, values);
            saved = this.row(ctx, scope, old.id, content);
            this.audit(ctx, 'created', actor, null, saved);
          } else
            ctx.write(async (tx) => {
              const inserted = await tx.insert(mcpMemories).values(values),
                id = Number(inserted[0].insertId);
              ctx.draft.upsert('mcpMemories', { ...values, id });
              saved = this.row(ctx, scope, id, content);
              this.audit(ctx, 'created', actor, null, saved);
            });
        } else {
          const slug = typeof input.project_slug === 'string' ? input.project_slug.trim() : '';
          if (!slug) throw new ValidationError('project_slug is required', { param: 'project_slug' });
          const project = ctx.draft
            .table('coordProjects')
            .all()
            .find((r) => r.slug === slug);
          if (!project) throw new NotFoundError('Project not found', 'project_not_found');
          if (
            ctx.draft
              .table('coordProjectMemories')
              .all()
              .some((r) => r.projectId === project.id && r.memoryKey === key)
          )
            throw new ConflictError('Memory already exists', 'memory_conflict');
          const values = {
            projectId: project.id,
            memoryKey: key,
            content,
            metadata,
            tags: tags.length ? tags : null,
            tagsText: tags.length ? tags.join(' ') : null,
            sourceHostId: null,
            createdAt: now,
            updatedAt: now,
          };
          ctx.write(async (tx) => {
            const inserted = await tx.insert(coordProjectMemories).values(values),
              id = Number(inserted[0].insertId);
            ctx.draft.upsert('coordProjectMemories', { ...values, id });
            saved = this.row(ctx, scope, id, content);
            this.audit(ctx, 'created', actor, null, saved);
          });
        }
        return () => ({ id: saved.recordId });
      },
    });
    return saved;
  }
  async change(
    scope: MemoryScope,
    id: number,
    input: Record<string, unknown>,
    actor: number,
    action: 'updated' | 'deleted' | 'appended' | 'restored' = 'updated',
  ): Promise<{ changed: boolean; row: UnifiedMemoryRow }> {
    let result!: { changed: boolean; row: UnifiedMemoryRow };
    await mutateOwnerState(requireOwnerRuntime(this.db), {
      kind: 'admin.memory.' + action,
      payload: { scope, id, actor },
      prepare: async (ctx) => {
        const currentMetadata =
          scope === 'host'
            ? ctx.snapshot.table('mcpMemories').get(id)
            : scope === 'project'
              ? ctx.snapshot.table('coordProjectMemories').get(id)
              : ctx.snapshot.table('sharedMemories').get(id);
        if (!currentMetadata || ('deletedAt' in currentMetadata && currentMetadata.deletedAt))
          throw new NotFoundError('Memory not found', 'memory_not_found');
        const table =
          scope === 'host' ? mcpMemories : scope === 'project' ? coordProjectMemories : sharedMemories;
        const [body] = await this.db
          .select({ content: table.content })
          .from(table)
          .where(eq(table.id, id))
          .limit(1);
        if (!body) throw new NotFoundError('Memory not found', 'memory_not_found');
        const before = this.row(ctx, scope, id, body.content);
        if (action !== 'appended') assertEtag(input.expected_etag, before);
        if (action === 'deleted') {
          if (scope === 'shared') {
            ctx.write(async (tx) => {
              await tx.delete(sharedMemoryChunks).where(eq(sharedMemoryChunks.memoryId, id));
              await tx.delete(sharedMemoryRevisions).where(eq(sharedMemoryRevisions.memoryId, id));
            });
            stageDelete(ctx, 'sharedMemories', id);
          } else stageDelete(ctx, scope === 'host' ? 'mcpMemories' : 'coordProjectMemories', id);
          this.audit(ctx, action, actor, before, null);
          result = { changed: true, row: before };
          return null;
        }
        let content = hasOwn(input, 'content')
          ? normalizeContent(input.content, scope === 'shared' ? MAX_CONTENT_CHARS : 32000)
          : before.content;
        if (action === 'appended') {
          const addition = normalizeContent(input.content, MAX_CONTENT_CHARS);
          content = before.content === '' ? addition : before.content.replace(/\s+$/, '') + '\n\n' + addition;
        }
        if (action === 'restored') {
          const revision = normalizePositiveInt(input.revision, 'revision');
          const [kept] = await this.db
            .select({ prevContent: sharedMemoryRevisions.prevContent })
            .from(sharedMemoryRevisions)
            .where(and(eq(sharedMemoryRevisions.memoryId, id), eq(sharedMemoryRevisions.revision, revision)))
            .limit(1);
          if (!kept) throw new NotFoundError(`Revision ${revision} not found`, 'memory_revision_not_found');
          if (kept.prevContent === null)
            throw new ValidationError(
              `Revision ${revision} kept no earlier body; only the newest replaces do`,
              { param: 'revision' },
            );
          content = kept.prevContent;
        }
        const tags = hasOwn(input, 'tags') ? normalizeTags(input.tags) : before.tags,
          metadata = hasOwn(input, 'metadata') ? normalizeMetadata(input.metadata) : before.metadata,
          summary = hasOwn(input, 'summary')
            ? normalizeNullableText(input.summary, 'summary', 1000)
            : before.summary,
          title = hasOwn(input, 'title')
            ? (normalizeNullableText(input.title, 'title', 255) ?? before.key)
            : before.title,
          engine = hasOwn(input, 'engine') ? normalizeEngine(input.engine) : before.engine;
        const next = { content, tags, metadata, summary, title, engine };
        if (
          action === 'updated' &&
          sameValue(next, {
            content: before.content,
            tags: before.tags,
            metadata: before.metadata,
            summary: before.summary,
            title: before.title,
            engine: before.engine,
          })
        ) {
          result = { changed: false, row: before };
          return null;
        }
        if (scope === 'shared') {
          const shared = new SharedMemoriesService(this.db, { publishEvents: false, ownerContext: ctx });
          if (action === 'appended')
            await shared.appendAlreadyLocked(
              { slug: before.key, content: input.content },
              null,
              isEngine(engine) ? engine : null,
            );
          else
            await shared.write(
              { slug: before.key, content, tags, metadata, summary, title },
              null,
              isEngine(engine) ? engine : null,
            );
          if (ctx.draft.table('sharedMemories').get(id)?.sourceEngine !== engine)
            stageUpdate(ctx, 'sharedMemories', id, { sourceEngine: engine, updatedAt: nowIso() });
        } else {
          const common = {
            content,
            metadata,
            tags: tags.length ? tags : null,
            tagsText: tags.length ? tags.join(' ') : null,
            updatedAt: nowIso(),
          };
          if (scope === 'host') stageUpdate(ctx, 'mcpMemories', id, { ...common, summary, engine });
          else stageUpdate(ctx, 'coordProjectMemories', id, { ...common, sourceHostId: null });
        }
        const after = this.row(ctx, scope, id, content);
        this.audit(ctx, action, actor, before, after);
        result = { changed: true, row: after };
        return null;
      },
    });
    return result;
  }
}

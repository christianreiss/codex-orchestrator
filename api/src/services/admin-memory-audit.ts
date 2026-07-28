import { and, desc, eq, inArray, like, lt, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { adminEvents, coordProjectEvents, logs, sharedMemoryRevisions } from '../db/schema.js';
import { sha256 } from '../security/hash.js';
import { AdminMemoryCatalog } from './admin-memory-catalog.js';
import {
  decodeActivityPosition,
  encodeActivityPosition,
  parseMemoryNodeId,
  sanitizeMemoryAuditDetails,
  type ActivityPosition,
  type UnifiedMemoryRow,
} from './admin-memory-model.js';

const SOURCE_ORDER = new Map([
  ['admin', 0],
  ['host_log', 1],
  ['project', 2],
  ['shared_revision', 3],
]);

interface Activity extends Record<string, unknown> {
  id: string;
  source: string;
  numeric_id: number;
  created_at: string | null;
}

export interface MemoryAuditContext {
  key: string | null;
  hostId: number | null;
  projectId: number | null;
  projectSlug: string | null;
}

export function resolveMemoryAuditContext(
  current: Pick<UnifiedMemoryRow, 'key' | 'ownerHostId' | 'projectId' | 'projectSlug'> | null,
  retainedPayload: unknown,
): MemoryAuditContext {
  const retained = sanitizeMemoryAuditDetails(retainedPayload);
  return {
    key: current?.key ?? (typeof retained?.['memory_id'] === 'string' ? retained['memory_id'] : null),
    hostId: current?.ownerHostId ?? optionalNumber(retained?.['host_id']),
    projectId: current?.projectId ?? optionalNumber(retained?.['project_id']),
    projectSlug:
      current?.projectSlug ??
      (typeof retained?.['project_slug'] === 'string' ? retained['project_slug'] : null),
  };
}

function afterActivity(
  source: string,
  createdAt: AnyColumn,
  id: AnyColumn,
  position: ActivityPosition | null,
): SQL | null {
  if (!position) return null;
  const beforeDate = lt(createdAt, position.createdAt);
  const sameDate = eq(createdAt, position.createdAt);
  const sourceOrder = SOURCE_ORDER.get(source) ?? 0;
  const cursorOrder = SOURCE_ORDER.get(position.source) ?? 0;
  if (sourceOrder < cursorOrder) return beforeDate;
  if (sourceOrder > cursorOrder) return or(beforeDate, sameDate) ?? beforeDate;
  return or(beforeDate, and(sameDate, lt(id, position.numericId))) ?? beforeDate;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export class AdminMemoryAudit {
  constructor(private readonly db: Database) {}

  async list(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const nodeId = typeof input['node_id'] === 'string' ? input['node_id'].trim() : '';
    const { scope, recordId } = parseMemoryNodeId(nodeId);
    const limit = Math.max(1, Math.min(200, Math.trunc(Number(input['limit'] ?? 50) || 50)));
    const fingerprint = sha256(`${nodeId}:${limit}`).slice(0, 16);
    const position =
      typeof input['cursor'] === 'string' && input['cursor'] !== ''
        ? decodeActivityPosition(input['cursor'], fingerprint)
        : null;
    const cap = limit + 1;
    const catalog = new AdminMemoryCatalog(this.db);
    const current = await catalog.loadAuditContext(scope, recordId);
    const retained = await this.retainedPayload(nodeId);
    const context = resolveMemoryAuditContext(current, retained);

    const requests: Array<Promise<Activity[]>> = [this.adminActivities(nodeId, position, cap)];
    if (scope === 'shared') requests.push(this.sharedActivities(recordId, position, cap));
    if (scope === 'project' && context.projectId !== null) {
      requests.push(this.projectActivities(context.projectId, recordId, position, cap));
    }
    if (context.key !== null) requests.push(this.logActivities(scope, context, position, cap));

    const candidates = (await Promise.all(requests)).flat();
    candidates.sort((a, b) => {
      const byDate = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
      if (byDate !== 0) return byDate;
      const bySource = (SOURCE_ORDER.get(a.source) ?? 0) - (SOURCE_ORDER.get(b.source) ?? 0);
      return bySource !== 0 ? bySource : b.numeric_id - a.numeric_id;
    });
    const truncated = candidates.length > limit;
    const page = candidates.slice(0, limit);
    const last = page.at(-1);
    return {
      status: 'ok',
      node_id: nodeId,
      activities: page.map(({ numeric_id: _numericId, ...activity }) => activity),
      next_cursor:
        truncated && last?.created_at
          ? encodeActivityPosition(
              { createdAt: last.created_at, source: last.source, numericId: last.numeric_id },
              fingerprint,
            )
          : null,
      truncated,
      retention: {
        kind: 'operational',
        immutable: false,
        body_history: false,
        retention_bound: true,
        sources: ['admin_events', 'logs', 'coord_project_events', 'shared_memory_revisions'],
        note: 'Metadata-only operational history subject to configured retention; it is not an immutable compliance ledger.',
      },
    };
  }

  private async retainedPayload(nodeId: string): Promise<unknown> {
    const rows = await this.db
      .select({ payload: adminEvents.payload })
      .from(adminEvents)
      .where(
        and(
          like(adminEvents.type, 'admin.memory.%'),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${adminEvents.payload}, '$.node_id')) = ${nodeId}`,
        ),
      )
      .orderBy(desc(adminEvents.createdAt), desc(adminEvents.id))
      .limit(1);
    return rows[0]?.payload ?? null;
  }

  private async adminActivities(
    nodeId: string,
    position: ActivityPosition | null,
    cap: number,
  ): Promise<Activity[]> {
    const conditions: SQL[] = [
      like(adminEvents.type, 'admin.memory.%'),
      sql`JSON_UNQUOTE(JSON_EXTRACT(${adminEvents.payload}, '$.node_id')) = ${nodeId}`,
    ];
    const cursor = afterActivity('admin', adminEvents.createdAt, adminEvents.id, position);
    if (cursor) conditions.push(cursor);
    const rows = await this.db
      .select()
      .from(adminEvents)
      .where(and(...conditions))
      .orderBy(desc(adminEvents.createdAt), desc(adminEvents.id))
      .limit(cap);
    return rows.map((row) => {
      const detail = sanitizeMemoryAuditDetails(row.payload);
      return {
        id: `admin:${row.id}`,
        numeric_id: Number(row.id),
        source: 'admin',
        action: row.type.replace(/^admin\.memory\./, ''),
        actor_type: 'admin',
        admin_id: detail?.['actor_id'] ?? null,
        source_host_id: row.hostId ?? null,
        source_engine: null,
        old_etag: detail?.['old_etag'] ?? null,
        new_etag: detail?.['new_etag'] ?? null,
        content_length: detail?.['content_length'] ?? null,
        delta_length:
          typeof detail?.['content_length'] === 'number' && typeof detail?.['old_content_length'] === 'number'
            ? Number(detail['content_length']) - Number(detail['old_content_length'])
            : null,
        tag_count: detail?.['tag_count'] ?? null,
        created_at: row.createdAt,
        details: detail,
      };
    });
  }

  private async sharedActivities(
    recordId: number,
    position: ActivityPosition | null,
    cap: number,
  ): Promise<Activity[]> {
    const conditions: SQL[] = [eq(sharedMemoryRevisions.memoryId, recordId)];
    const cursor = afterActivity(
      'shared_revision',
      sharedMemoryRevisions.createdAt,
      sharedMemoryRevisions.id,
      position,
    );
    if (cursor) conditions.push(cursor);
    const rows = await this.db
      .select()
      .from(sharedMemoryRevisions)
      .where(and(...conditions))
      .orderBy(desc(sharedMemoryRevisions.createdAt), desc(sharedMemoryRevisions.id))
      .limit(cap);
    return rows.map((row) => ({
      id: `shared_revision:${row.id}`,
      numeric_id: Number(row.id),
      source: 'shared_revision',
      action: row.op,
      actor_type: row.sourceHostId ? 'host' : row.sourceEngine ? 'engine' : 'system',
      admin_id: null,
      source_host_id: row.sourceHostId ?? null,
      source_engine: row.sourceEngine ?? null,
      old_etag: null,
      new_etag: null,
      content_length: row.contentLength,
      delta_length: row.deltaLength,
      tag_count: null,
      created_at: row.createdAt,
      details: { revision: row.revision, sha256: row.contentSha256, note: row.note },
    }));
  }

  private async projectActivities(
    projectId: number,
    recordId: number,
    position: ActivityPosition | null,
    cap: number,
  ): Promise<Activity[]> {
    const conditions: SQL[] = [
      eq(coordProjectEvents.projectId, projectId),
      eq(coordProjectEvents.entityType, 'memory'),
      eq(coordProjectEvents.entityId, String(recordId)),
    ];
    const cursor = afterActivity('project', coordProjectEvents.createdAt, coordProjectEvents.id, position);
    if (cursor) conditions.push(cursor);
    const rows = await this.db
      .select()
      .from(coordProjectEvents)
      .where(and(...conditions))
      .orderBy(desc(coordProjectEvents.createdAt), desc(coordProjectEvents.id))
      .limit(cap);
    return rows.map((row) => {
      const payload = row.payloadJson as Record<string, unknown> | null;
      return {
        id: `project:${row.id}`,
        numeric_id: Number(row.id),
        source: 'project',
        action: row.action,
        actor_type: row.sourceHostId ? 'host' : 'system',
        admin_id: null,
        source_host_id: row.sourceHostId ?? null,
        source_engine: null,
        old_etag: null,
        new_etag: null,
        content_length: payload?.['content_length'] ?? null,
        delta_length: null,
        tag_count: Array.isArray(payload?.['tags']) ? payload['tags'].length : null,
        created_at: row.createdAt,
        details: sanitizeMemoryAuditDetails(payload),
      };
    });
  }

  private async logActivities(
    scope: 'host' | 'project' | 'shared',
    context: MemoryAuditContext,
    position: ActivityPosition | null,
    cap: number,
  ): Promise<Activity[]> {
    if (scope === 'host' && context.hostId === null) return [];
    if (scope === 'project' && context.projectSlug === null) return [];
    const conditions: SQL[] = [sql`JSON_VALID(${logs.details})`];
    if (scope === 'host') {
      const hostId = context.hostId as number;
      conditions.push(
        inArray(logs.action, ['memory.store', 'memory.delete']),
        eq(logs.hostId, hostId),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${logs.details}, '$.id')) = ${context.key}`,
      );
    } else if (scope === 'project') {
      conditions.push(
        inArray(logs.action, [
          'project.memory.created',
          'project.memory.updated',
          'project.memory.unchanged',
          'project.memory.delete',
        ]),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${logs.details}, '$.slug')) = ${context.projectSlug}`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${logs.details}, '$.key')) = ${context.key}`,
      );
    } else {
      conditions.push(
        inArray(logs.action, [
          'shared_memory.write',
          'shared_memory.append',
          'shared_memory.delete',
          'shared_memory.admin.delete',
        ]),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${logs.details}, '$.slug')) = ${context.key}`,
      );
    }
    const cursor = afterActivity('host_log', logs.createdAt, logs.id, position);
    if (cursor) conditions.push(cursor);
    const rows = await this.db
      .select()
      .from(logs)
      .where(and(...conditions))
      .orderBy(desc(logs.createdAt), desc(logs.id))
      .limit(cap);
    return rows.map((row) => {
      const detail = sanitizeMemoryAuditDetails(row.details);
      return {
        id: `log:${row.id}`,
        numeric_id: Number(row.id),
        source: 'host_log',
        action: row.action,
        actor_type: row.hostId ? 'host' : row.engine ? 'engine' : 'system',
        admin_id: null,
        source_host_id: row.hostId ?? null,
        source_engine: row.engine ?? null,
        old_etag: null,
        new_etag: null,
        content_length: detail?.['content_length'] ?? null,
        delta_length: null,
        tag_count: detail?.['tags'] ?? null,
        created_at: row.createdAt,
        details: detail,
      };
    });
  }
}

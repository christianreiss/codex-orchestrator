import { and, desc, eq, isNull, like, lt, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { coordProjectMemories, coordProjects, hosts, mcpMemories, sharedMemories } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { sha256 } from '../security/hash.js';
import { parseTags } from './memory-tags.js';
import {
  MEMORY_SCOPES,
  decodeGraphPosition,
  encodeGraphPosition,
  memoryCapabilities,
  memoryNodeId,
  normalizeEngine,
  normalizeList,
  normalizePositiveInt,
  stableValue,
  toMemoryDetail,
  type GraphFilters,
  type GraphPosition,
  type MemoryDetail,
  type MemoryScope,
  type UnifiedMemoryRow,
} from './admin-memory-model.js';

const SCOPE_ORDER = new Map<MemoryScope, number>(MEMORY_SCOPES.map((scope, index) => [scope, index]));
export const MEMORY_FACET_LIMIT = 200;
const MEMORY_FACET_QUERY_LIMIT = MEMORY_FACET_LIMIT + 1;

export function boundedFacetItems<T>(items: T[]): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, MEMORY_FACET_LIMIT), truncated: items.length > MEMORY_FACET_LIMIT };
}

function escapedLike(value: string): string {
  return `%${value.replace(/[%_]/g, '\\$&')}%`;
}

function tagConditions(column: AnyColumn, tags: string[]): SQL[] {
  return tags.map(
    (tag) => sql`JSON_CONTAINS(LOWER(CAST(COALESCE(${column}, JSON_ARRAY()) AS CHAR)), JSON_QUOTE(${tag}))`,
  );
}

function afterPosition(
  scope: MemoryScope,
  updatedAt: AnyColumn,
  recordId: AnyColumn,
  position: GraphPosition | null,
): SQL | null {
  if (!position) return null;
  const beforeDate = lt(updatedAt, position.updatedAt);
  const sameDate = eq(updatedAt, position.updatedAt);
  const scopeOrder = SCOPE_ORDER.get(scope) ?? 0;
  const cursorOrder = SCOPE_ORDER.get(position.scope) ?? 0;
  if (scopeOrder < cursorOrder) return beforeDate;
  if (scopeOrder > cursorOrder) return or(beforeDate, sameDate) ?? beforeDate;
  return or(beforeDate, and(sameDate, lt(recordId, position.recordId))) ?? beforeDate;
}

function rowsFromExecute(result: unknown): Array<Record<string, unknown>> {
  const first = Array.isArray(result) ? result[0] : result;
  return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
}

export class AdminMemoryCatalog {
  constructor(private readonly db: Database) {}

  async graph(input: Record<string, unknown>, canMutate: boolean): Promise<Record<string, unknown>> {
    const filters = this.normalizeGraphFilters(input);
    const [candidateRows, facetData] = await Promise.all([
      this.pageRows(filters),
      this.aggregateFacets(filters),
    ]);
    candidateRows.sort((a, b) => {
      const byDate = String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
      if (byDate !== 0) return byDate;
      const byScope = (SCOPE_ORDER.get(a.scope) ?? 0) - (SCOPE_ORDER.get(b.scope) ?? 0);
      return byScope !== 0 ? byScope : b.recordId - a.recordId;
    });

    const truncated = candidateRows.length > filters.limit;
    const pageRows = candidateRows.slice(0, filters.limit);
    const graphNodes = new Map<string, Record<string, unknown>>();
    const edges: Record<string, unknown>[] = [];
    const addNode = (node: Record<string, unknown> & { id: string }): void => {
      if (!graphNodes.has(node.id)) graphNodes.set(node.id, node);
    };
    const addEdge = (source: string, target: string, type: string): void => {
      edges.push({ id: `${type}:${source}:${target}`, source, target, type });
    };

    for (const row of pageRows) {
      const nodeId = memoryNodeId(row.scope, row.recordId);
      addNode({
        id: nodeId,
        node_id: nodeId,
        kind: 'memory',
        label: row.title,
        memory_id: row.key,
        key: row.key,
        record_id: row.recordId,
        scope: row.scope,
        title: row.title,
        summary: row.summary,
        preview: row.preview,
        tags: row.tags,
        content_length: row.contentLength,
        host_id: row.ownerHostId,
        host: row.ownerHost,
        project_id: row.projectId,
        project_slug: row.projectSlug,
        source_host_id: row.sourceHostId,
        source_host: row.sourceHost,
        engine: row.engine,
        revision: row.revision,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        capabilities: memoryCapabilities(row.scope, canMutate),
      });

      const scopeId = `scope:${row.scope}`;
      addNode({
        id: scopeId,
        kind: 'scope',
        label: row.scope === 'host' ? 'Host-local' : row.scope === 'project' ? 'Projects' : 'Fleet-wide',
        scope: row.scope,
      });
      addEdge(nodeId, scopeId, 'in_scope');

      if (row.ownerHostId !== null) {
        const hostId = `host:${row.ownerHostId}`;
        addNode({
          id: hostId,
          kind: 'host',
          label: row.ownerHost ?? `Host ${row.ownerHostId}`,
          host_id: row.ownerHostId,
        });
        addEdge(nodeId, hostId, 'owned_by');
      }
      if (row.projectSlug !== null) {
        const projectId = `project:${encodeURIComponent(row.projectSlug)}`;
        addNode({
          id: projectId,
          kind: 'project',
          label: row.projectSlug,
          project_id: row.projectId,
          project_slug: row.projectSlug,
        });
        addEdge(nodeId, projectId, 'in_project');
      }
      if (row.sourceHostId !== null && row.sourceHostId !== row.ownerHostId) {
        const hostId = `host:${row.sourceHostId}`;
        addNode({
          id: hostId,
          kind: 'host',
          label: row.sourceHost ?? `Host ${row.sourceHostId}`,
          host_id: row.sourceHostId,
        });
        addEdge(nodeId, hostId, 'written_by');
      }
      for (const tag of row.tags) {
        const tagId = `tag:${encodeURIComponent(tag.toLowerCase())}`;
        addNode({ id: tagId, kind: 'tag', label: tag, tag });
        addEdge(nodeId, tagId, 'tagged_with');
      }
      if (row.engine !== null) {
        const engineId = `engine:${row.engine}`;
        addNode({ id: engineId, kind: 'engine', label: row.engine, engine: row.engine });
        addEdge(nodeId, engineId, 'from_engine');
      }
    }

    const last = pageRows.at(-1);
    return {
      status: 'ok',
      nodes: [...graphNodes.values()],
      edges,
      facets: facetData.facets,
      facets_truncated: facetData.facetsTruncated,
      totals: facetData.totals,
      count: pageRows.length,
      next_cursor:
        truncated && last?.updatedAt
          ? encodeGraphPosition(
              { updatedAt: last.updatedAt, scope: last.scope, recordId: last.recordId },
              filters.fingerprint,
            )
          : null,
      truncated,
    };
  }

  async detail(scope: MemoryScope, recordId: number, canMutate: boolean): Promise<MemoryDetail> {
    const row = await this.loadRow(scope, recordId);
    if (!row) throw new NotFoundError('Memory not found', 'memory_not_found');
    return toMemoryDetail(row, canMutate);
  }

  /** Body-free identity lookup used to correlate operational audit sources. */
  async loadAuditContext(
    scope: MemoryScope,
    recordId: number,
  ): Promise<Pick<UnifiedMemoryRow, 'key' | 'ownerHostId' | 'projectId' | 'projectSlug'> | null> {
    if (scope === 'host') {
      const rows = await this.db
        .select({ key: mcpMemories.memoryKey, hostId: mcpMemories.hostId })
        .from(mcpMemories)
        .where(and(eq(mcpMemories.id, recordId), isNull(mcpMemories.deletedAt)))
        .limit(1);
      return rows[0]
        ? { key: rows[0].key, ownerHostId: Number(rows[0].hostId), projectId: null, projectSlug: null }
        : null;
    }
    if (scope === 'project') {
      const rows = await this.db
        .select({
          key: coordProjectMemories.memoryKey,
          projectId: coordProjects.id,
          projectSlug: coordProjects.slug,
        })
        .from(coordProjectMemories)
        .innerJoin(coordProjects, eq(coordProjects.id, coordProjectMemories.projectId))
        .where(eq(coordProjectMemories.id, recordId))
        .limit(1);
      return rows[0]
        ? {
            key: rows[0].key,
            ownerHostId: null,
            projectId: Number(rows[0].projectId),
            projectSlug: rows[0].projectSlug,
          }
        : null;
    }
    const rows = await this.db
      .select({ key: sharedMemories.slug })
      .from(sharedMemories)
      .where(and(eq(sharedMemories.id, recordId), isNull(sharedMemories.deletedAt)))
      .limit(1);
    return rows[0] ? { key: rows[0].key, ownerHostId: null, projectId: null, projectSlug: null } : null;
  }

  async loadRow(scope: MemoryScope, recordId: number): Promise<UnifiedMemoryRow | null> {
    if (scope === 'host') {
      const rows = await this.db
        .select({ memory: mcpMemories, host: hosts.fqdn })
        .from(mcpMemories)
        .leftJoin(hosts, eq(hosts.id, mcpMemories.hostId))
        .where(and(eq(mcpMemories.id, recordId), isNull(mcpMemories.deletedAt)))
        .limit(1);
      const item = rows[0];
      if (!item) return null;
      const row = item.memory;
      return {
        scope,
        recordId: Number(row.id),
        key: row.memoryKey,
        title: row.memoryKey,
        summary: row.summary ?? null,
        content: row.content,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
        tags: parseTags(row.tags),
        contentLength: row.content.length,
        preview: row.content.slice(0, 280),
        ownerHostId: Number(row.hostId),
        ownerHost: item.host ?? null,
        projectId: null,
        projectSlug: null,
        sourceHostId: null,
        sourceHost: null,
        engine: row.engine ?? null,
        revision: null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }
    if (scope === 'project') {
      const rows = await this.db
        .select({
          memory: coordProjectMemories,
          projectId: coordProjects.id,
          projectSlug: coordProjects.slug,
          sourceHost: hosts.fqdn,
        })
        .from(coordProjectMemories)
        .innerJoin(coordProjects, eq(coordProjects.id, coordProjectMemories.projectId))
        .leftJoin(hosts, eq(hosts.id, coordProjectMemories.sourceHostId))
        .where(eq(coordProjectMemories.id, recordId))
        .limit(1);
      const item = rows[0];
      if (!item) return null;
      const row = item.memory;
      return {
        scope,
        recordId: Number(row.id),
        key: row.memoryKey,
        title: row.memoryKey,
        summary: null,
        content: row.content,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
        tags: parseTags(row.tags),
        contentLength: row.content.length,
        preview: row.content.slice(0, 280),
        ownerHostId: null,
        ownerHost: null,
        projectId: Number(item.projectId),
        projectSlug: item.projectSlug,
        sourceHostId: row.sourceHostId === null ? null : Number(row.sourceHostId),
        sourceHost: item.sourceHost ?? null,
        engine: null,
        revision: null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }
    const rows = await this.db
      .select({ memory: sharedMemories, sourceHost: hosts.fqdn })
      .from(sharedMemories)
      .leftJoin(hosts, eq(hosts.id, sharedMemories.sourceHostId))
      .where(and(eq(sharedMemories.id, recordId), isNull(sharedMemories.deletedAt)))
      .limit(1);
    const item = rows[0];
    if (!item) return null;
    const row = item.memory;
    return {
      scope,
      recordId: Number(row.id),
      key: row.slug,
      title: row.title,
      summary: row.summary ?? null,
      content: row.content,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      tags: parseTags(row.tags),
      contentLength: Number(row.contentLength),
      preview: row.content.slice(0, 280),
      ownerHostId: null,
      ownerHost: null,
      projectId: null,
      projectSlug: null,
      sourceHostId: row.sourceHostId === null ? null : Number(row.sourceHostId),
      sourceHost: item.sourceHost ?? null,
      engine: row.sourceEngine ?? null,
      revision: Number(row.revision),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private normalizeGraphFilters(input: Record<string, unknown>): GraphFilters {
    const requestedScopes = normalizeList(input['scopes'] ?? input['scope']);
    const scopes =
      requestedScopes.length === 0
        ? [...MEMORY_SCOPES]
        : requestedScopes.map((scope) => {
            if (!(MEMORY_SCOPES as readonly string[]).includes(scope)) {
              throw new ValidationError(`unknown memory scope: ${scope}`, { param: 'scopes' });
            }
            return scope as MemoryScope;
          });
    const tags = normalizeList(input['tags']).map((tag) => tag.toLowerCase());
    const q =
      typeof input['q'] === 'string'
        ? input['q'].trim()
        : typeof input['query'] === 'string'
          ? input['query'].trim()
          : '';
    const hostId =
      input['host_id'] === undefined || input['host_id'] === null || input['host_id'] === ''
        ? null
        : normalizePositiveInt(input['host_id'], 'host_id');
    const projectSlug =
      typeof input['project_slug'] === 'string' && input['project_slug'].trim() !== ''
        ? input['project_slug'].trim()
        : null;
    const engine =
      input['engine'] === undefined || input['engine'] === null || input['engine'] === ''
        ? null
        : normalizeEngine(input['engine']);
    const limitRaw = Number(input['limit'] ?? 500);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.trunc(limitRaw))) : 500;
    const fingerprint = sha256(
      JSON.stringify(stableValue({ scopes, tags, q, hostId, projectSlug, engine, limit })),
    ).slice(0, 16);
    const position =
      typeof input['cursor'] === 'string' && input['cursor'] !== ''
        ? decodeGraphPosition(input['cursor'], fingerprint)
        : null;
    return { scopes, q, tags, hostId, projectSlug, engine, limit, position, fingerprint };
  }

  private hostConditions(filters: GraphFilters, withCursor: boolean): SQL[] {
    const conditions: SQL[] = [
      isNull(mcpMemories.deletedAt),
      ...tagConditions(mcpMemories.tags, filters.tags),
    ];
    if (filters.hostId !== null) conditions.push(eq(mcpMemories.hostId, filters.hostId));
    if (filters.engine !== null) conditions.push(eq(mcpMemories.engine, filters.engine));
    if (filters.q) {
      const pattern = escapedLike(filters.q);
      const expression = or(
        like(mcpMemories.memoryKey, pattern),
        like(mcpMemories.content, pattern),
        like(mcpMemories.tagsText, pattern),
        like(mcpMemories.summary, pattern),
        like(hosts.fqdn, pattern),
      );
      if (expression) conditions.push(expression);
    }
    if (withCursor) {
      const cursor = afterPosition('host', mcpMemories.updatedAt, mcpMemories.id, filters.position);
      if (cursor) conditions.push(cursor);
    }
    return conditions;
  }

  private projectConditions(filters: GraphFilters, withCursor: boolean): SQL[] {
    const conditions: SQL[] = [...tagConditions(coordProjectMemories.tags, filters.tags)];
    if (filters.projectSlug !== null) conditions.push(eq(coordProjects.slug, filters.projectSlug));
    if (filters.hostId !== null) conditions.push(eq(coordProjectMemories.sourceHostId, filters.hostId));
    if (filters.q) {
      const pattern = escapedLike(filters.q);
      const expression = or(
        like(coordProjectMemories.memoryKey, pattern),
        like(coordProjectMemories.content, pattern),
        like(coordProjectMemories.tagsText, pattern),
        like(coordProjects.slug, pattern),
      );
      if (expression) conditions.push(expression);
    }
    if (withCursor) {
      const cursor = afterPosition(
        'project',
        coordProjectMemories.updatedAt,
        coordProjectMemories.id,
        filters.position,
      );
      if (cursor) conditions.push(cursor);
    }
    return conditions;
  }

  private sharedConditions(filters: GraphFilters, withCursor: boolean): SQL[] {
    const conditions: SQL[] = [
      isNull(sharedMemories.deletedAt),
      ...tagConditions(sharedMemories.tags, filters.tags),
    ];
    if (filters.hostId !== null) conditions.push(eq(sharedMemories.sourceHostId, filters.hostId));
    if (filters.engine !== null) conditions.push(eq(sharedMemories.sourceEngine, filters.engine));
    if (filters.q) {
      const pattern = escapedLike(filters.q);
      const expression = or(
        like(sharedMemories.slug, pattern),
        like(sharedMemories.title, pattern),
        like(sharedMemories.summary, pattern),
        like(sharedMemories.content, pattern),
        like(sharedMemories.tagsText, pattern),
      );
      if (expression) conditions.push(expression);
    }
    if (withCursor) {
      const cursor = afterPosition('shared', sharedMemories.updatedAt, sharedMemories.id, filters.position);
      if (cursor) conditions.push(cursor);
    }
    return conditions;
  }

  private async pageRows(filters: GraphFilters): Promise<UnifiedMemoryRow[]> {
    const requests: Array<Promise<UnifiedMemoryRow[]>> = [];
    const cap = filters.limit + 1;
    if (filters.scopes.includes('host') && filters.projectSlug === null) {
      requests.push(
        this.db
          .select({
            recordId: mcpMemories.id,
            key: mcpMemories.memoryKey,
            summary: mcpMemories.summary,
            tags: mcpMemories.tags,
            contentLength: sql<number>`CHAR_LENGTH(${mcpMemories.content})`,
            preview: sql<string>`LEFT(${mcpMemories.content}, 280)`,
            hostId: mcpMemories.hostId,
            host: hosts.fqdn,
            engine: mcpMemories.engine,
            createdAt: mcpMemories.createdAt,
            updatedAt: mcpMemories.updatedAt,
          })
          .from(mcpMemories)
          .leftJoin(hosts, eq(hosts.id, mcpMemories.hostId))
          .where(and(...this.hostConditions(filters, true)))
          .orderBy(sql`${mcpMemories.updatedAt} DESC`, sql`${mcpMemories.id} DESC`)
          .limit(cap)
          .then((found) =>
            found.map((item) => ({
              scope: 'host' as const,
              recordId: Number(item.recordId),
              key: item.key,
              title: item.key,
              summary: item.summary ?? null,
              content: '',
              metadata: null,
              tags: parseTags(item.tags),
              contentLength: Number(item.contentLength ?? 0),
              preview: String(item.preview ?? ''),
              ownerHostId: Number(item.hostId),
              ownerHost: item.host ?? null,
              projectId: null,
              projectSlug: null,
              sourceHostId: null,
              sourceHost: null,
              engine: item.engine ?? null,
              revision: null,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            })),
          ),
      );
    }
    if (filters.scopes.includes('project') && filters.engine === null) {
      requests.push(
        this.db
          .select({
            recordId: coordProjectMemories.id,
            key: coordProjectMemories.memoryKey,
            tags: coordProjectMemories.tags,
            contentLength: sql<number>`CHAR_LENGTH(${coordProjectMemories.content})`,
            preview: sql<string>`LEFT(${coordProjectMemories.content}, 280)`,
            projectId: coordProjects.id,
            projectSlug: coordProjects.slug,
            sourceHostId: coordProjectMemories.sourceHostId,
            sourceHost: hosts.fqdn,
            createdAt: coordProjectMemories.createdAt,
            updatedAt: coordProjectMemories.updatedAt,
          })
          .from(coordProjectMemories)
          .innerJoin(coordProjects, eq(coordProjects.id, coordProjectMemories.projectId))
          .leftJoin(hosts, eq(hosts.id, coordProjectMemories.sourceHostId))
          .where(and(...this.projectConditions(filters, true)))
          .orderBy(sql`${coordProjectMemories.updatedAt} DESC`, sql`${coordProjectMemories.id} DESC`)
          .limit(cap)
          .then((found) =>
            found.map((item) => ({
              scope: 'project' as const,
              recordId: Number(item.recordId),
              key: item.key,
              title: item.key,
              summary: null,
              content: '',
              metadata: null,
              tags: parseTags(item.tags),
              contentLength: Number(item.contentLength ?? 0),
              preview: String(item.preview ?? ''),
              ownerHostId: null,
              ownerHost: null,
              projectId: Number(item.projectId),
              projectSlug: item.projectSlug,
              sourceHostId: item.sourceHostId === null ? null : Number(item.sourceHostId),
              sourceHost: item.sourceHost ?? null,
              engine: null,
              revision: null,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            })),
          ),
      );
    }
    if (filters.scopes.includes('shared') && filters.projectSlug === null) {
      requests.push(
        this.db
          .select({
            recordId: sharedMemories.id,
            key: sharedMemories.slug,
            title: sharedMemories.title,
            summary: sharedMemories.summary,
            tags: sharedMemories.tags,
            contentLength: sharedMemories.contentLength,
            preview: sql<string>`LEFT(${sharedMemories.content}, 280)`,
            sourceHostId: sharedMemories.sourceHostId,
            sourceHost: hosts.fqdn,
            engine: sharedMemories.sourceEngine,
            revision: sharedMemories.revision,
            createdAt: sharedMemories.createdAt,
            updatedAt: sharedMemories.updatedAt,
          })
          .from(sharedMemories)
          .leftJoin(hosts, eq(hosts.id, sharedMemories.sourceHostId))
          .where(and(...this.sharedConditions(filters, true)))
          .orderBy(sql`${sharedMemories.updatedAt} DESC`, sql`${sharedMemories.id} DESC`)
          .limit(cap)
          .then((found) =>
            found.map((item) => ({
              scope: 'shared' as const,
              recordId: Number(item.recordId),
              key: item.key,
              title: item.title,
              summary: item.summary ?? null,
              content: '',
              metadata: null,
              tags: parseTags(item.tags),
              contentLength: Number(item.contentLength),
              preview: String(item.preview ?? ''),
              ownerHostId: null,
              ownerHost: null,
              projectId: null,
              projectSlug: null,
              sourceHostId: item.sourceHostId === null ? null : Number(item.sourceHostId),
              sourceHost: item.sourceHost ?? null,
              engine: item.engine ?? null,
              revision: Number(item.revision),
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            })),
          ),
      );
    }
    return (await Promise.all(requests)).flat();
  }

  private async aggregateFacets(filters: GraphFilters): Promise<{
    totals: Record<'all' | MemoryScope, number>;
    facets: Record<string, unknown>;
    facetsTruncated: { hosts: boolean; projects: boolean; tags: boolean };
  }> {
    const hostEnabled = filters.scopes.includes('host') && filters.projectSlug === null;
    const projectEnabled = filters.scopes.includes('project') && filters.engine === null;
    const sharedEnabled = filters.scopes.includes('shared') && filters.projectSlug === null;

    const [hostCountRows, projectCountRows, sharedCountRows] = await Promise.all([
      hostEnabled
        ? this.db
            .select({ count: sql<number>`COUNT(*)` })
            .from(mcpMemories)
            .leftJoin(hosts, eq(hosts.id, mcpMemories.hostId))
            .where(and(...this.hostConditions(filters, false)))
        : Promise.resolve([]),
      projectEnabled
        ? this.db
            .select({ count: sql<number>`COUNT(*)` })
            .from(coordProjectMemories)
            .innerJoin(coordProjects, eq(coordProjects.id, coordProjectMemories.projectId))
            .leftJoin(hosts, eq(hosts.id, coordProjectMemories.sourceHostId))
            .where(and(...this.projectConditions(filters, false)))
        : Promise.resolve([]),
      sharedEnabled
        ? this.db
            .select({ count: sql<number>`COUNT(*)` })
            .from(sharedMemories)
            .leftJoin(hosts, eq(hosts.id, sharedMemories.sourceHostId))
            .where(and(...this.sharedConditions(filters, false)))
        : Promise.resolve([]),
    ]);
    const totals = {
      host: Number(hostCountRows[0]?.count ?? 0),
      project: Number(projectCountRows[0]?.count ?? 0),
      shared: Number(sharedCountRows[0]?.count ?? 0),
      all: 0,
    };
    totals.all = totals.host + totals.project + totals.shared;

    const [
      hostGroups,
      projectHostGroups,
      sharedHostGroups,
      projectGroups,
      hostEngines,
      sharedEngines,
      tagGroups,
    ] = await Promise.all([
      hostEnabled
        ? this.db
            .select({ id: mcpMemories.hostId, label: hosts.fqdn, count: sql<number>`COUNT(*)` })
            .from(mcpMemories)
            .leftJoin(hosts, eq(hosts.id, mcpMemories.hostId))
            .where(and(...this.hostConditions(filters, false)))
            .groupBy(mcpMemories.hostId, hosts.fqdn)
            .orderBy(desc(sql<number>`COUNT(*)`), mcpMemories.hostId)
            .limit(MEMORY_FACET_QUERY_LIMIT)
        : Promise.resolve([]),
      projectEnabled
        ? this.db
            .select({
              id: coordProjectMemories.sourceHostId,
              label: hosts.fqdn,
              count: sql<number>`COUNT(*)`,
            })
            .from(coordProjectMemories)
            .innerJoin(coordProjects, eq(coordProjects.id, coordProjectMemories.projectId))
            .leftJoin(hosts, eq(hosts.id, coordProjectMemories.sourceHostId))
            .where(and(...this.projectConditions(filters, false)))
            .groupBy(coordProjectMemories.sourceHostId, hosts.fqdn)
            .orderBy(desc(sql<number>`COUNT(*)`), coordProjectMemories.sourceHostId)
            .limit(MEMORY_FACET_QUERY_LIMIT)
        : Promise.resolve([]),
      sharedEnabled
        ? this.db
            .select({ id: sharedMemories.sourceHostId, label: hosts.fqdn, count: sql<number>`COUNT(*)` })
            .from(sharedMemories)
            .leftJoin(hosts, eq(hosts.id, sharedMemories.sourceHostId))
            .where(and(...this.sharedConditions(filters, false)))
            .groupBy(sharedMemories.sourceHostId, hosts.fqdn)
            .orderBy(desc(sql<number>`COUNT(*)`), sharedMemories.sourceHostId)
            .limit(MEMORY_FACET_QUERY_LIMIT)
        : Promise.resolve([]),
      projectEnabled
        ? this.db
            .select({ slug: coordProjects.slug, label: coordProjects.slug, count: sql<number>`COUNT(*)` })
            .from(coordProjectMemories)
            .innerJoin(coordProjects, eq(coordProjects.id, coordProjectMemories.projectId))
            .leftJoin(hosts, eq(hosts.id, coordProjectMemories.sourceHostId))
            .where(and(...this.projectConditions(filters, false)))
            .groupBy(coordProjects.slug)
            .orderBy(desc(sql<number>`COUNT(*)`), coordProjects.slug)
            .limit(MEMORY_FACET_QUERY_LIMIT)
        : Promise.resolve([]),
      hostEnabled
        ? this.db
            .select({ value: mcpMemories.engine, count: sql<number>`COUNT(*)` })
            .from(mcpMemories)
            .leftJoin(hosts, eq(hosts.id, mcpMemories.hostId))
            .where(and(...this.hostConditions(filters, false), sql`${mcpMemories.engine} IS NOT NULL`))
            .groupBy(mcpMemories.engine)
        : Promise.resolve([]),
      sharedEnabled
        ? this.db
            .select({ value: sharedMemories.sourceEngine, count: sql<number>`COUNT(*)` })
            .from(sharedMemories)
            .leftJoin(hosts, eq(hosts.id, sharedMemories.sourceHostId))
            .where(
              and(...this.sharedConditions(filters, false), sql`${sharedMemories.sourceEngine} IS NOT NULL`),
            )
            .groupBy(sharedMemories.sourceEngine)
        : Promise.resolve([]),
      this.aggregateTags(filters, { hostEnabled, projectEnabled, sharedEnabled }),
    ]);

    const mergedHosts = new Map<number, { id: number; label: string; count: number }>();
    for (const row of [...hostGroups, ...projectHostGroups, ...sharedHostGroups]) {
      if (row.id === null) continue;
      const id = Number(row.id);
      const current = mergedHosts.get(id) ?? { id, label: row.label ?? `Host ${id}`, count: 0 };
      current.count += Number(row.count ?? 0);
      mergedHosts.set(id, current);
    }
    const mergedEngines = new Map<string, number>();
    for (const row of [...hostEngines, ...sharedEngines]) {
      if (!row.value) continue;
      mergedEngines.set(row.value, (mergedEngines.get(row.value) ?? 0) + Number(row.count ?? 0));
    }
    const byCount = <T extends { count: number }>(a: T, b: T): number => b.count - a.count;
    const hostsFacet = boundedFacetItems([...mergedHosts.values()].sort(byCount));
    const projectsFacet = boundedFacetItems(
      projectGroups
        .map((row) => ({ slug: row.slug, label: row.label, count: Number(row.count) }))
        .sort(byCount),
    );
    return {
      totals,
      facets: {
        scopes: MEMORY_SCOPES.filter((scope) => filters.scopes.includes(scope)).map((value) => ({
          value,
          count: totals[value],
        })),
        hosts: hostsFacet.items,
        projects: projectsFacet.items,
        tags: tagGroups.items,
        engines: [...mergedEngines].map(([value, count]) => ({ value, count })).sort(byCount),
      },
      facetsTruncated: {
        hosts:
          hostsFacet.truncated ||
          hostGroups.length > MEMORY_FACET_LIMIT ||
          projectHostGroups.length > MEMORY_FACET_LIMIT ||
          sharedHostGroups.length > MEMORY_FACET_LIMIT,
        projects: projectsFacet.truncated,
        tags: tagGroups.truncated,
      },
    };
  }

  private async aggregateTags(
    filters: GraphFilters,
    enabled: { hostEnabled: boolean; projectEnabled: boolean; sharedEnabled: boolean },
  ): Promise<{ items: Array<{ value: string; count: number }>; truncated: boolean }> {
    const queries: Array<Promise<unknown>> = [];
    if (enabled.hostEnabled) {
      queries.push(
        this.db.execute(sql`
          SELECT LOWER(jt.tag) AS tag_key, MIN(jt.tag) AS value, COUNT(*) AS count
          FROM ${mcpMemories}
          LEFT JOIN ${hosts} ON ${hosts.id} = ${mcpMemories.hostId}
          JOIN JSON_TABLE(COALESCE(${mcpMemories.tags}, JSON_ARRAY()), '$[*]' COLUMNS(tag VARCHAR(64) PATH '$')) AS jt ON TRUE
          WHERE ${and(sql`TRUE`, ...this.hostConditions(filters, false))}
          GROUP BY LOWER(jt.tag)
          ORDER BY count DESC, tag_key ASC
          LIMIT ${MEMORY_FACET_QUERY_LIMIT}
        `),
      );
    }
    if (enabled.projectEnabled) {
      queries.push(
        this.db.execute(sql`
          SELECT LOWER(jt.tag) AS tag_key, MIN(jt.tag) AS value, COUNT(*) AS count
          FROM ${coordProjectMemories}
          JOIN ${coordProjects} ON ${coordProjects.id} = ${coordProjectMemories.projectId}
          LEFT JOIN ${hosts} ON ${hosts.id} = ${coordProjectMemories.sourceHostId}
          JOIN JSON_TABLE(COALESCE(${coordProjectMemories.tags}, JSON_ARRAY()), '$[*]' COLUMNS(tag VARCHAR(64) PATH '$')) AS jt ON TRUE
          WHERE ${and(sql`TRUE`, ...this.projectConditions(filters, false))}
          GROUP BY LOWER(jt.tag)
          ORDER BY count DESC, tag_key ASC
          LIMIT ${MEMORY_FACET_QUERY_LIMIT}
        `),
      );
    }
    if (enabled.sharedEnabled) {
      queries.push(
        this.db.execute(sql`
          SELECT LOWER(jt.tag) AS tag_key, MIN(jt.tag) AS value, COUNT(*) AS count
          FROM ${sharedMemories}
          LEFT JOIN ${hosts} ON ${hosts.id} = ${sharedMemories.sourceHostId}
          JOIN JSON_TABLE(COALESCE(${sharedMemories.tags}, JSON_ARRAY()), '$[*]' COLUMNS(tag VARCHAR(64) PATH '$')) AS jt ON TRUE
          WHERE ${and(sql`TRUE`, ...this.sharedConditions(filters, false))}
          GROUP BY LOWER(jt.tag)
          ORDER BY count DESC, tag_key ASC
          LIMIT ${MEMORY_FACET_QUERY_LIMIT}
        `),
      );
    }
    const merged = new Map<string, { value: string; count: number }>();
    let sourceTruncated = false;
    for (const result of await Promise.all(queries)) {
      const rows = rowsFromExecute(result);
      sourceTruncated ||= rows.length > MEMORY_FACET_LIMIT;
      for (const row of rows) {
        const key = String(row['tag_key'] ?? '').toLowerCase();
        if (!key) continue;
        const current = merged.get(key) ?? { value: String(row['value'] ?? key), count: 0 };
        current.count += Number(row['count'] ?? 0);
        merged.set(key, current);
      }
    }
    const bounded = boundedFacetItems(
      [...merged.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    );
    return { items: bounded.items, truncated: sourceTruncated || bounded.truncated };
  }
}

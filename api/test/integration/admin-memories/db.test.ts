import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import {
  AdminMemoriesService,
  type MemoryDetail,
  type MemoryScope,
} from '../../../src/services/admin-memories.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';

/**
 * Real-MySQL coverage for the unified admin memory lifecycle.
 *
 * CI normally has no database, so this file skips there. Run it with either:
 *
 *   npm run test:db
 *   TEST_DATABASE_URL=mysql://root:pw@127.0.0.1:3306/db \
 *     npx vitest run test/integration/admin-memories/db.test.ts --no-file-parallelism
 *
 * The project/shared migrations are applied here because both are idempotent
 * and this test must also work against a schema initially built by Drizzle.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  join(HERE, '../../../src/db/migrations/0003_add_coord_project_memories.sql'),
  join(HERE, '../../../src/db/migrations/0006_add_shared_memories.sql'),
];

const PREFIX = 'ztest-admin-atlas';
const HOST_FQDN = `${PREFIX}.example`;
const PROJECT_SLUG = `${PREFIX}-project`;
const HOST_KEY = `${PREFIX}-host`;
const PROJECT_KEY = `${PREFIX}-project-memory`;
const SHARED_SLUG = `${PREFIX}-shared`;
const COMMON_TAG = PREFIX;
const ACTOR_ID = 424_242;

const handle = await getTestDb();

interface Fixture {
  scope: MemoryScope;
  detail: MemoryDetail;
  initialContent: string;
  updatedContent: string;
  metadataMarker: string;
}

function longBody(marker: string, phase: 'initial' | 'updated'): string {
  return `${marker} ${phase}: ${`${phase} lifecycle payload `.repeat(24).trimEnd()}`;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const first = Array.isArray(result) ? (result[0] as unknown) : result;
  return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
}

function assertAuditIsBodyFree(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertAuditIsBodyFree(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    expect(key.toLowerCase()).not.toMatch(
      /^(?:body|content|preview|metadata)$|_(?:body|content|preview|metadata)$/,
    );
    assertAuditIsBodyFree(item);
  }
}

describe.skipIf(!handle)('admin memory atlas against a real database', { timeout: 120_000 }, () => {
  let db: TestDb;
  let service: AdminMemoriesService;
  let hostId: number;

  const exec = async (query: string) => db.execute(sql.raw(query));

  const cleanup = async (): Promise<void> => {
    await exec(
      `DELETE FROM admin_events
        WHERE type LIKE 'admin.memory.%'
          AND CAST(payload AS CHAR) LIKE '%${PREFIX}%'`,
    );
    await exec(
      `DELETE FROM logs
        WHERE (action LIKE 'admin.memory.%' OR action LIKE 'shared_memory.%')
          AND details LIKE '%${PREFIX}%'`,
    );
    await exec(
      `DELETE FROM shared_memory_chunks
        WHERE memory_id IN (SELECT id FROM shared_memories WHERE slug LIKE '${PREFIX}%')`,
    );
    await exec(
      `DELETE FROM shared_memory_revisions
        WHERE memory_id IN (SELECT id FROM shared_memories WHERE slug LIKE '${PREFIX}%')`,
    );
    await exec(`DELETE FROM shared_memories WHERE slug LIKE '${PREFIX}%'`);
    await exec(
      `DELETE FROM coord_project_events
        WHERE project_id IN (SELECT id FROM coord_projects WHERE slug = '${PROJECT_SLUG}')`,
    );
    await exec(
      `DELETE FROM coord_project_memories
        WHERE project_id IN (SELECT id FROM coord_projects WHERE slug = '${PROJECT_SLUG}')`,
    );
    await exec(`DELETE FROM coord_projects WHERE slug = '${PROJECT_SLUG}'`);
    await exec(`DELETE FROM mcp_memories WHERE memory_key LIKE '${PREFIX}%'`);
    await exec(`DELETE FROM hosts WHERE fqdn = '${HOST_FQDN}'`);
  };

  beforeAll(async () => {
    db = handle!.db;
    for (const migration of MIGRATIONS) {
      for (const statement of splitSqlStatements(readFileSync(migration, 'utf8'))) {
        await exec(statement);
      }
    }
    await cleanup();

    const now = new Date().toISOString();
    await exec(
      `INSERT INTO hosts (fqdn, api_key, status, created_at, updated_at)
       VALUES ('${HOST_FQDN}', SHA2('${HOST_FQDN}', 256), 'active', '${now}', '${now}')`,
    );
    const hosts = rowsOf(await exec(`SELECT id FROM hosts WHERE fqdn = '${HOST_FQDN}'`));
    hostId = Number(hosts[0]!['id']);
    await exec(
      `INSERT INTO coord_projects (slug, created_at, updated_at)
       VALUES ('${PROJECT_SLUG}', '${now}', '${now}')`,
    );
    service = new AdminMemoriesService(db);
  });

  afterAll(async () => {
    await cleanup();
    await handle?.pool.end();
  });

  it('runs create, graph, optimistic update, append, audit, and hard-delete across every scope', async () => {
    const hostMarker = `${PREFIX}-host-body`;
    const projectMarker = `${PREFIX}-project-body`;
    const sharedMarker = `${PREFIX}-shared-body`;
    const hostMetadataMarker = `${PREFIX}-host-metadata-secret`;
    const projectMetadataMarker = `${PREFIX}-project-metadata-secret`;
    const sharedMetadataMarker = `${PREFIX}-shared-metadata-secret`;

    const hostContent = longBody(hostMarker, 'initial');
    const projectContent = longBody(projectMarker, 'initial');
    const sharedContent = longBody(sharedMarker, 'initial');

    const createdHost = await service.create(
      'host',
      {
        id: HOST_KEY,
        host_id: hostId,
        content: hostContent,
        summary: 'Host-local atlas fixture',
        metadata: { marker: hostMetadataMarker, nested: { private_note: 'redact me' } },
        tags: [COMMON_TAG, 'host-fixture'],
        engine: 'codex',
      },
      ACTOR_ID,
    );
    const createdProject = await service.create(
      'project',
      {
        id: PROJECT_KEY,
        project_slug: PROJECT_SLUG,
        content: projectContent,
        metadata: { marker: projectMetadataMarker, nested: { private_note: 'redact me' } },
        tags: [COMMON_TAG, 'project-fixture'],
      },
      ACTOR_ID,
    );
    const createdShared = await service.create(
      'shared',
      {
        id: SHARED_SLUG,
        title: 'Shared atlas fixture title',
        summary: 'Shared atlas fixture summary',
        content: sharedContent,
        metadata: { marker: sharedMetadataMarker, nested: { private_note: 'redact me' } },
        tags: [COMMON_TAG, 'shared-fixture'],
        engine: 'claude',
      },
      ACTOR_ID,
    );

    const fixtures: Fixture[] = [
      {
        scope: 'host',
        detail: createdHost.memory,
        initialContent: hostContent,
        updatedContent: longBody(hostMarker, 'updated'),
        metadataMarker: hostMetadataMarker,
      },
      {
        scope: 'project',
        detail: createdProject.memory,
        initialContent: projectContent,
        updatedContent: longBody(projectMarker, 'updated'),
        metadataMarker: projectMetadataMarker,
      },
      {
        scope: 'shared',
        detail: createdShared.memory,
        initialContent: sharedContent,
        updatedContent: longBody(sharedMarker, 'updated'),
        metadataMarker: sharedMetadataMarker,
      },
    ];

    for (const fixture of fixtures) {
      const detail = await service.detail(fixture.scope, fixture.detail.record_id, true);
      expect(detail).toMatchObject({
        node_id: fixture.detail.node_id,
        scope: fixture.scope,
        content: fixture.initialContent,
        metadata: { marker: fixture.metadataMarker },
        capabilities: { read: true, create: true, update: true, delete: true },
      });
      expect(detail.etag).toMatch(/^[0-9a-f]{64}$/);
    }

    const graph = (await service.graph({ tags: [COMMON_TAG], limit: 20 }, true)) as {
      nodes: Array<Record<string, unknown>>;
      totals: Record<string, number>;
    };
    const memoryNodes = graph.nodes.filter((node) => node['kind'] === 'memory');
    expect(memoryNodes.map((node) => node['id']).sort()).toEqual(
      fixtures.map((fixture) => fixture.detail.node_id).sort(),
    );
    expect(graph.totals).toEqual({ all: 3, host: 1, project: 1, shared: 1 });
    for (const node of memoryNodes) {
      expect(node).not.toHaveProperty('content');
      expect(node).not.toHaveProperty('metadata');
      expect(node).toHaveProperty('content_length');
    }
    const serializedGraph = JSON.stringify(graph);
    for (const fixture of fixtures) {
      expect(serializedGraph).not.toContain(fixture.initialContent);
      expect(serializedGraph).not.toContain(fixture.metadataMarker);
    }

    const updated = new Map<MemoryScope, MemoryDetail>();
    for (const fixture of fixtures) {
      const fresh = await service.update(
        fixture.scope,
        fixture.detail.record_id,
        { expected_etag: fixture.detail.etag, content: fixture.updatedContent },
        ACTOR_ID,
      );
      expect(fresh.status).toBe('updated');
      expect(fresh.memory.etag).not.toBe(fixture.detail.etag);

      await expect(
        service.update(
          fixture.scope,
          fixture.detail.record_id,
          {
            expected_etag: fixture.detail.etag,
            content: `${PREFIX}-stale-overwrite-${fixture.scope}`,
            metadata: { marker: `${PREFIX}-stale-metadata-${fixture.scope}` },
          },
          ACTOR_ID,
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'memory_conflict',
        extra: { current_etag: fresh.memory.etag, node_id: fixture.detail.node_id },
      });

      const persisted = await service.detail(fixture.scope, fixture.detail.record_id, true);
      expect(persisted.content).toBe(fixture.updatedContent);
      expect(persisted.metadata).toMatchObject({ marker: fixture.metadataMarker });
      expect(JSON.stringify(persisted.metadata)).not.toContain(`${PREFIX}-stale-metadata`);
      updated.set(fixture.scope, persisted);
    }

    const sharedBeforeAppend = updated.get('shared')!;
    const addition = `${PREFIX}-append-body`;
    const appended = await service.appendShared(sharedBeforeAppend.record_id, addition, ACTOR_ID);
    expect(appended.memory).toMatchObject({
      title: 'Shared atlas fixture title',
      summary: 'Shared atlas fixture summary',
      metadata: { marker: sharedMetadataMarker, nested: { private_note: 'redact me' } },
      tags: [COMMON_TAG, 'shared-fixture'],
    });
    expect(appended.memory.content).toBe(`${sharedBeforeAppend.content}\n\n${addition}`);
    expect(appended.memory.etag).not.toBe(sharedBeforeAppend.etag);
    updated.set('shared', appended.memory);

    for (const fixture of fixtures) {
      const current = updated.get(fixture.scope)!;
      const audit = (await service.audit({ node_id: current.node_id, limit: 200 })) as {
        activities: Array<Record<string, unknown>>;
        retention: Record<string, unknown>;
      };
      const adminActivities = audit.activities.filter((activity) => activity['source'] === 'admin');
      expect(adminActivities.map((activity) => activity['action'])).toEqual(
        expect.arrayContaining(
          fixture.scope === 'shared' ? ['created', 'updated', 'appended'] : ['created', 'updated'],
        ),
      );
      expect(adminActivities.some((activity) => activity['content_length'] === current.content_length)).toBe(
        true,
      );
      expect(audit.retention).toMatchObject({ body_history: false, immutable: false });
      assertAuditIsBodyFree(audit.activities);

      const serializedAudit = JSON.stringify(audit.activities);
      expect(serializedAudit).not.toContain(fixture.initialContent);
      expect(serializedAudit).not.toContain(fixture.updatedContent);
      expect(serializedAudit).not.toContain(fixture.metadataMarker);
      expect(serializedAudit).not.toContain('redact me');
    }

    for (const fixture of fixtures) {
      const current = updated.get(fixture.scope)!;
      await expect(
        service.remove(fixture.scope, current.record_id, current.etag, ACTOR_ID),
      ).resolves.toMatchObject({
        status: 'deleted',
        node_id: current.node_id,
      });
      await expect(service.detail(fixture.scope, current.record_id, true)).rejects.toMatchObject({
        status: 404,
        code: 'memory_not_found',
      });

      const audit = (await service.audit({ node_id: current.node_id, limit: 200 })) as {
        activities: Array<Record<string, unknown>>;
      };
      const deletion = audit.activities.find(
        (activity) => activity['source'] === 'admin' && activity['action'] === 'deleted',
      );
      expect(deletion).toMatchObject({
        content_length: null,
        details: { old_content_length: current.content_length, content_length: null },
      });
      assertAuditIsBodyFree(audit.activities);
    }

    const emptyGraph = (await service.graph({ tags: [COMMON_TAG], limit: 20 }, true)) as {
      nodes: Array<Record<string, unknown>>;
      totals: Record<string, number>;
    };
    expect(emptyGraph.nodes.filter((node) => node['kind'] === 'memory')).toHaveLength(0);
    expect(emptyGraph.totals).toEqual({ all: 0, host: 0, project: 0, shared: 0 });

    const ids = Object.fromEntries(
      fixtures.map((fixture) => [fixture.scope, updated.get(fixture.scope)!.record_id]),
    ) as Record<MemoryScope, number>;
    const physicalRows = rowsOf(
      await exec(
        `SELECT
           (SELECT COUNT(*) FROM mcp_memories WHERE id = ${ids.host}) AS host_rows,
           (SELECT COUNT(*) FROM coord_project_memories WHERE id = ${ids.project}) AS project_rows,
           (SELECT COUNT(*) FROM shared_memories WHERE id = ${ids.shared}) AS shared_rows,
           (SELECT COUNT(*) FROM shared_memory_chunks WHERE memory_id = ${ids.shared}) AS shared_chunks,
           (SELECT COUNT(*) FROM shared_memory_revisions WHERE memory_id = ${ids.shared}) AS shared_revisions`,
      ),
    )[0]!;
    expect(Number(physicalRows['host_rows'])).toBe(0);
    expect(Number(physicalRows['project_rows'])).toBe(0);
    expect(Number(physicalRows['shared_rows'])).toBe(0);
    expect(Number(physicalRows['shared_chunks'])).toBe(0);
    expect(Number(physicalRows['shared_revisions'])).toBe(0);

    const facetNow = new Date().toISOString();
    const facetValues = Array.from({ length: 201 }, (_, index) => {
      const suffix = String(index).padStart(3, '0');
      return `(${hostId}, '${PREFIX}-facet-${suffix}', '${PREFIX}-facet-content', JSON_ARRAY('${PREFIX}-facet-tag-${suffix}'), '${PREFIX}-facet-tag-${suffix}', '${facetNow}', '${facetNow}')`;
    });
    await exec(
      `INSERT INTO mcp_memories
        (host_id, memory_key, content, tags, tags_text, created_at, updated_at)
       VALUES ${facetValues.join(',')}`,
    );
    const boundedFacets = (await service.graph(
      { scopes: ['host'], q: `${PREFIX}-facet`, limit: 1 },
      true,
    )) as {
      nodes: Array<Record<string, unknown>>;
      totals: Record<string, number>;
      facets: { hosts: unknown[]; projects: unknown[]; tags: unknown[] };
      facets_truncated: { hosts: boolean; projects: boolean; tags: boolean };
    };
    expect(boundedFacets.nodes.filter((node) => node['kind'] === 'memory')).toHaveLength(1);
    expect(boundedFacets.totals).toEqual({ all: 201, host: 201, project: 0, shared: 0 });
    expect(boundedFacets.facets).toMatchObject({ hosts: expect.any(Array), projects: [] });
    expect(boundedFacets.facets.tags).toHaveLength(200);
    expect(boundedFacets.facets_truncated).toEqual({ hosts: false, projects: false, tags: true });
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { registerProjectsClientRoutes } from '../../../src/routes/projects-client/index.js';
import { HostProjectsService } from '../../../src/services/host-projects.js';
import { ProjectsService } from '../../../src/services/projects.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import type { RouteContext } from '../../../src/routes/index.js';
import type { Host } from '../../../src/db/schema.js';

/**
 * The only tests that exercise project memories against real MySQL.
 *
 * Everything else in the unit suite runs on `db-fake`, which never issues a
 * query — so the raw `MATCH … AGAINST` search, the FULLTEXT index, the FK
 * cascade, and the event/seq SQL have no coverage there by construction. CI
 * runs without a database, so these skip there; run them with:
 *
 *   npm run test:db          (TEST_USE_DB=1 + DB_* env)
 *   TEST_USE_DB=1 TEST_DATABASE_URL=mysql://root:pw@127.0.0.1:3306/db \
 *     npx vitest run test/integration --no-file-parallelism
 *
 * The suite applies `0003_add_coord_project_memories.sql` itself (the file is
 * idempotent), which both makes it self-sufficient and covers the migration —
 * including its backstop for a table created by `drizzle-kit push`, which cannot
 * express FULLTEXT.
 */

/** Split a migration into statements; mysql2 rejects multi-statement by default. */
function sqlStatements(text: string): string[] {
  return text
    .split(/;\s*$/m)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/db/migrations/0003_add_coord_project_memories.sql',
);

const SLUG = 'ztest-memories';
const OTHER_SLUG = 'ztest-memories-other';
const FQDN_A = 'ztest-mem-a.example';
const FQDN_B = 'ztest-mem-b.example';

const handle = await getTestDb();

describe.skipIf(!handle)('project memories against a real database', () => {
  let db: TestDb;
  let svc: HostProjectsService;
  let app: FastifyInstance;
  let hostA: Host;
  let hostB: Host;

  const exec = async (q: string) => db.execute(sql.raw(q));
  const rowsOf = (res: unknown): Array<Record<string, unknown>> => {
    const first = Array.isArray(res) ? (res[0] as unknown) : res;
    return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
  };
  const cleanup = async () => {
    await exec(`DELETE FROM coord_projects WHERE slug IN ('${SLUG}', '${OTHER_SLUG}')`);
    await exec(`DELETE FROM hosts WHERE fqdn IN ('${FQDN_A}', '${FQDN_B}')`);
  };

  beforeAll(async () => {
    db = handle!.db;
    for (const stmt of sqlStatements(readFileSync(MIGRATION, 'utf8'))) await exec(stmt);
    await cleanup();

    const now = new Date().toISOString();
    for (const fqdn of [FQDN_A, FQDN_B]) {
      await exec(
        `INSERT INTO hosts (fqdn, api_key, status, created_at, updated_at)
         VALUES ('${fqdn}', SHA2('${fqdn}', 256), 'active', '${now}', '${now}')`,
      );
    }
    const hostRows = rowsOf(await exec(`SELECT id, fqdn FROM hosts WHERE fqdn IN ('${FQDN_A}', '${FQDN_B}') ORDER BY fqdn`));
    hostA = hostRows.find((r) => r['fqdn'] === FQDN_A) as unknown as Host;
    hostB = hostRows.find((r) => r['fqdn'] === FQDN_B) as unknown as Host;

    svc = new HostProjectsService(db);
    await svc.createProject({ slug: SLUG }, hostA);
    await svc.createProject({ slug: OTHER_SLUG }, hostA);

    app = Fastify({ logger: false });
    await app.register(envelopePlugin);
    app.decorate('requireHost', async (req: FastifyRequest) => {
      req.authHost = hostA;
    });
    await registerProjectsClientRoutes(app, { db, env: {}, keyring: {} } as unknown as RouteContext);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await handle?.pool.end();
  });

  // The migration guarantees the full-text index on any database, however the
  // table got there. That matters because `drizzle-kit push` builds it from
  // schema.ts, which can express neither FULLTEXT nor (for any coord_project_*
  // table) foreign keys — so a push-built database reaches the migration with
  // the table already present and the index missing, and `CREATE TABLE IF NOT
  // EXISTS` alone would silently leave search degraded forever.
  it('guarantees the FULLTEXT index exists after the migration runs', async () => {
    const idx = rowsOf(
      await exec(
        `SELECT INDEX_NAME, INDEX_TYPE FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coord_project_memories'
            AND INDEX_NAME = 'idx_coord_project_memories_search'`,
      ),
    );
    expect(idx).toHaveLength(2); // one row per indexed column: content, tags_text
    expect(idx[0]!['INDEX_TYPE']).toBe('FULLTEXT');
  });

  it('is idempotent — re-running the migration changes nothing', async () => {
    for (const stmt of sqlStatements(readFileSync(MIGRATION, 'utf8'))) await exec(stmt);
    const idx = rowsOf(
      await exec(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coord_project_memories'
            AND INDEX_NAME = 'idx_coord_project_memories_search'`,
      ),
    );
    expect(idx).toHaveLength(2);
    const unique = rowsOf(
      await exec(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coord_project_memories'
            AND INDEX_NAME = 'uniq_coord_project_memory_key'`,
      ),
    );
    expect(unique.length).toBeGreaterThan(0);
  });

  it('enforces one row per (project, key)', async () => {
    await svc.upsertMemory(SLUG, { key: 'dupe.check', content: 'first' }, hostA);
    await svc.upsertMemory(SLUG, { key: 'dupe.check', content: 'second' }, hostA);
    const rows = rowsOf(
      await exec(
        `SELECT COUNT(*) AS c FROM coord_project_memories m
           JOIN coord_projects p ON p.id = m.project_id
          WHERE p.slug = '${SLUG}' AND m.memory_key = 'dupe.check'`,
      ),
    );
    expect(Number(rows[0]!['c'])).toBe(1);
  });

  it('returns scored full-text matches without leaking across projects', async () => {
    await svc.upsertMemory(SLUG, {
      key: 'deploy.crane',
      content: 'crane deploys are manual via FQDN because the workflow targets the wrong directory',
      tags: ['ops', 'deploy'],
    }, hostA);
    await svc.upsertMemory(OTHER_SLUG, {
      key: 'other.crane',
      content: 'crane deploys mentioned in a different project entirely',
    }, hostA);

    const hit = (await svc.searchMemories(SLUG, { query: 'crane deploys manual' }, hostA)) as {
      count: number;
      degraded: boolean;
      matches: Array<{ key: string; score?: number | null }>;
    };

    expect(hit.degraded).toBe(false);
    expect(hit.matches.map((m) => m.key)).toEqual(['deploy.crane']);
    expect(typeof hit.matches[0]!.score).toBe('number');
  });

  it('AND-filters full-text matches by tag', async () => {
    await svc.upsertMemory(SLUG, { key: 'tagged.both', content: 'shared vocabulary token alpha', tags: ['ops', 'deploy'] }, hostA);
    await svc.upsertMemory(SLUG, { key: 'tagged.one', content: 'shared vocabulary token alpha', tags: ['ops'] }, hostA);

    const both = (await svc.searchMemories(SLUG, { query: 'vocabulary alpha', tags: ['ops', 'deploy'] }, hostA)) as {
      matches: Array<{ key: string }>;
    };

    expect(both.matches.map((m) => m.key)).toEqual(['tagged.both']);
  });

  it('makes one host\'s memory visible to another, with attribution', async () => {
    await svc.upsertMemory(SLUG, { key: 'cross.host', content: 'written by host A' }, hostA);

    const seen = (await svc.getMemory(SLUG, 'cross.host', hostB)) as {
      status: string;
      memory: { source_host_id: number } | null;
    };

    expect(seen.status).toBe('found');
    expect(seen.memory?.source_host_id).toBe(Number((hostA as unknown as { id: number }).id));

    const updated = (await svc.upsertMemory(SLUG, { key: 'cross.host', content: 'updated by host B' }, hostB)) as {
      status: string;
      memory: { source_host_id: number } | null;
    };
    expect(updated.status).toBe('updated');
    expect(updated.memory?.source_host_id).toBe(Number((hostB as unknown as { id: number }).id));
  });

  it('surfaces memory mutations in project_changes but not for an unchanged re-store', async () => {
    const seqBefore = (await svc.findBySlug(SLUG))!.latest_event_seq;
    await svc.upsertMemory(SLUG, { key: 'evented', content: 'first write', tags: ['x'] }, hostA);
    const seqAfterWrite = (await svc.findBySlug(SLUG))!.latest_event_seq;
    expect(seqAfterWrite).toBeGreaterThan(seqBefore);

    // Identical re-store: no write, no event, no seq bump -- otherwise every
    // other host re-syncs for nothing.
    const again = (await svc.upsertMemory(SLUG, { key: 'evented', content: 'first write', tags: ['X'] }, hostA)) as {
      status: string;
    };
    expect(again.status).toBe('unchanged');
    expect((await svc.findBySlug(SLUG))!.latest_event_seq).toBe(seqAfterWrite);

    const changes = (await svc.listChanges(SLUG, seqBefore, hostA)) as {
      changes: Array<{ event_type: string; action: string; entity_id: string; payload: Record<string, unknown> }>;
    };
    const memEvents = changes.changes.filter((c) => c.event_type === 'memory');
    expect(memEvents.map((e) => e.action)).toEqual(['create']);
    // entity_id is VARCHAR(64) while memory_key is VARCHAR(128): the numeric row
    // id goes in the column, the key rides in the payload.
    expect(String(memEvents[0]!.entity_id).length).toBeLessThanOrEqual(64);
    expect(memEvents[0]!.payload['key']).toBe('evented');
    expect(memEvents[0]!.payload).not.toHaveProperty('content');
    expect(memEvents[0]!.payload).toHaveProperty('preview');
  });

  it('stores a 128-char key without overflowing the VARCHAR(64) event column', async () => {
    const longKey = 'k'.repeat(128);
    const res = (await svc.upsertMemory(SLUG, { key: longKey, content: 'long key body' }, hostA)) as { status: string };
    expect(res.status).toBe('created');

    const got = (await svc.getMemory(SLUG, longKey, hostA)) as { status: string };
    expect(got.status).toBe('found');
  });

  it('degrades to a substring scan when the FULLTEXT index is missing, then recovers', async () => {
    await svc.upsertMemory(SLUG, { key: 'degrade.me', content: 'zqxjv distinctive marker' }, hostA);
    await exec('ALTER TABLE coord_project_memories DROP INDEX idx_coord_project_memories_search');
    try {
      const out = (await svc.searchMemories(SLUG, { query: 'zqxjv' }, hostA)) as {
        degraded: boolean;
        matches: Array<{ key: string }>;
      };
      expect(out.degraded).toBe(true);
      expect(out.matches.map((m) => m.key)).toContain('degrade.me');
    } finally {
      await exec('ALTER TABLE coord_project_memories ADD FULLTEXT INDEX idx_coord_project_memories_search (content, tags_text)');
    }

    const recovered = (await svc.searchMemories(SLUG, { query: 'zqxjv' }, hostA)) as { degraded: boolean };
    expect(recovered.degraded).toBe(false);
  });

  // Deliberately drives ProjectsService.deleteBySlug rather than a raw DELETE:
  // that method removes each child explicitly, which is the code path the admin
  // surface actually runs. Relying on the FK would only test MySQL, and would
  // not hold on a push-built database (schema.ts declares no foreign keys).
  it('leaves no orphaned memories when the project is deleted', async () => {
    const doomed = `${SLUG}-doomed`;
    await svc.createProject({ slug: doomed }, hostA);
    await svc.upsertMemory(doomed, { key: 'doomed', content: 'about to be deleted' }, hostA);
    const projectId = Number((await svc.findBySlug(doomed))!.id);

    const before = rowsOf(await exec(`SELECT COUNT(*) AS c FROM coord_project_memories WHERE project_id = ${projectId}`));
    expect(Number(before[0]!['c'])).toBe(1);

    await new ProjectsService(db).deleteBySlug(doomed);

    const after = rowsOf(await exec(`SELECT COUNT(*) AS c FROM coord_project_memories WHERE project_id = ${projectId}`));
    expect(Number(after[0]!['c'])).toBe(0);
  });

  // Note on shape: the standard envelope spreads the payload at the root as well
  // as nesting it under `data`, so our own `status: created|updated|unchanged`
  // overwrites the envelope's `status: "ok"` at the root. That collision is
  // pre-existing and identical on /mcp/memories/store, which returns the same
  // field — so these routes stay consistent with it. Assert against `data`.
  describe('REST mirror', () => {
    it('round-trips upsert, list, get, search, and delete over HTTP', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/projects/${SLUG}/memories`,
        payload: { key: 'rest.route', content: 'written over REST', tags: ['http'] },
      });
      expect(created.statusCode).toBe(200);
      expect(JSON.parse(created.payload).data).toMatchObject({ status: 'created', id: 'rest.route' });

      const got = await app.inject({ method: 'GET', url: `/projects/${SLUG}/memories/rest.route` });
      expect(JSON.parse(got.payload).data).toMatchObject({ status: 'found', memory: { content: 'written over REST' } });

      // POST /memories/search must not be shadowed by GET /memories/:key.
      const searched = await app.inject({ method: 'POST', url: `/projects/${SLUG}/memories/search`, payload: {} });
      expect(searched.statusCode).toBe(200);
      expect(JSON.parse(searched.payload).data.count).toBeGreaterThan(0);

      const deleted = await app.inject({ method: 'DELETE', url: `/projects/${SLUG}/memories/rest.route` });
      expect(JSON.parse(deleted.payload).data).toMatchObject({ status: 'deleted' });

      const gone = await app.inject({ method: 'GET', url: `/projects/${SLUG}/memories/rest.route` });
      expect(JSON.parse(gone.payload).data).toMatchObject({ status: 'missing' });
    });

    // The GET delivers flags as query strings; the MCP tool path delivers real
    // booleans. Both have to mean the same thing.
    it('coerces the include_content query-string flag', async () => {
      await app.inject({
        method: 'POST',
        url: `/projects/${SLUG}/memories`,
        payload: { key: 'rest.flag', content: 'full body over rest' },
      });

      const previews = await app.inject({ method: 'GET', url: `/projects/${SLUG}/memories` });
      const previewRow = JSON.parse(previews.payload).data.memories.find((m: { key: string }) => m.key === 'rest.flag');
      expect(previewRow).not.toHaveProperty('content');
      expect(previewRow).toHaveProperty('preview');

      const full = await app.inject({ method: 'GET', url: `/projects/${SLUG}/memories?include_content=true` });
      const fullRow = JSON.parse(full.payload).data.memories.find((m: { key: string }) => m.key === 'rest.flag');
      expect(fullRow.content).toBe('full body over rest');
    });

    it('rejects an invalid key through the route with a validation error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/projects/${SLUG}/memories`,
        payload: { key: 'bad key!', content: 'x' },
      });
      expect(res.statusCode).toBe(422);
    });
  });
});

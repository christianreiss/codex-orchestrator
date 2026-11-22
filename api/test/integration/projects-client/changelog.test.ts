import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { HostProjectsService } from '../../../src/services/host-projects.js';
import { ProjectChangelogService } from '../../../src/services/project-changelog.js';
import { ProjectsService } from '../../../src/services/projects.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import type { Host } from '../../../src/db/schema.js';

/**
 * The project changelog against real MySQL: the FULLTEXT search, its degraded
 * fallback, the migration's idempotence, the event/seq SQL and the FK cascade —
 * none of which `db-fake` can exercise. Skips without TEST_USE_DB=1 (see
 * memories.test.ts for how to run it).
 */

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
  '../../../src/db/migrations/0149_add_coord_project_changelog.sql',
);

const SLUG = 'ztest-changelog';
const OTHER_SLUG = 'ztest-changelog-other';
const FQDN_A = 'ztest-cl-a.example';
const FQDN_B = 'ztest-cl-b.example';

const handle = await getTestDb();

describe.skipIf(!handle)('project changelog against a real database', () => {
  let db: TestDb;
  let svc: ProjectChangelogService;
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
    const hostRows = rowsOf(await exec(`SELECT id, fqdn FROM hosts WHERE fqdn IN ('${FQDN_A}', '${FQDN_B}')`));
    hostA = hostRows.find((r) => r['fqdn'] === FQDN_A) as unknown as Host;
    hostB = hostRows.find((r) => r['fqdn'] === FQDN_B) as unknown as Host;
    const projects = new HostProjectsService(db);
    await projects.createProject({ slug: SLUG }, hostA);
    await projects.createProject({ slug: OTHER_SLUG }, hostA);
    svc = new ProjectChangelogService(db, new ProjectsService(db));
  });

  afterAll(async () => {
    await cleanup();
    await handle?.pool.end();
  });

  it('creates the FULLTEXT index and re-runs idempotently', async () => {
    for (const stmt of sqlStatements(readFileSync(MIGRATION, 'utf8'))) await exec(stmt);
    const idx = rowsOf(
      await exec(
        `SELECT INDEX_TYPE FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coord_project_changelog'
            AND INDEX_NAME = 'idx_coord_project_changelog_search'`,
      ),
    );
    expect(idx).toHaveLength(3);
    expect(idx[0]!['INDEX_TYPE']).toBe('FULLTEXT');
  });

  it('appends, searches, enforces ownership and records events', async () => {
    const a = await svc.append(
      SLUG,
      { title: 'Rotated gateway credentials', body: 'Old keys leaked into a log.', kind: 'ops', tags: ['security'] },
      { hostId: hostA.id },
    );
    await svc.append(OTHER_SLUG, { title: 'Unrelated rename', kind: 'change' }, { hostId: hostB.id });

    const found = await svc.search({ query: 'credentials', slug: SLUG });
    expect(found.degraded).toBeUndefined();
    expect(found.entries.map((e) => e.id)).toEqual([a.entry.id]);
    expect((await svc.search({ query: 'credentials', slug: OTHER_SLUG })).entries).toEqual([]);
    expect((await svc.search({ tag: 'security' })).entries.map((e) => e.id)).toContain(a.entry.id);

    await expect(svc.update(SLUG, a.entry.id, { title: 'nope' }, { hostId: hostB.id })).rejects.toMatchObject({
      code: 'not_owner',
    });
    await svc.update(SLUG, a.entry.id, { body: 'Old keys leaked into a debug log.' }, { hostId: hostA.id });
    await svc.delete(SLUG, a.entry.id, { hostId: hostA.id });

    const events = rowsOf(
      await exec(
        `SELECT e.action, e.payload_json FROM coord_project_events e JOIN coord_projects p ON p.id = e.project_id
          WHERE p.slug = '${SLUG}' AND e.entity_type = 'changelog' ORDER BY e.seq`,
      ),
    );
    expect(events.map((e) => e['action'])).toEqual(['create', 'update', 'delete']);
    const deleted = events[2]!['payload_json'];
    const payload = typeof deleted === 'string' ? JSON.parse(deleted) : deleted;
    expect(payload).toMatchObject({ title: 'Rotated gateway credentials', body: 'Old keys leaked into a debug log.' });
  });

  it('degrades to a substring scan when the FULLTEXT index is missing', async () => {
    const { entry } = await svc.append(SLUG, { title: 'Pinned the toolchain' }, { hostId: hostA.id });
    await exec('ALTER TABLE coord_project_changelog DROP INDEX idx_coord_project_changelog_search');
    try {
      const found = await svc.search({ query: 'toolchain', slug: SLUG });
      expect(found.degraded).toBe(true);
      expect(found.entries.map((e) => e.id)).toEqual([entry.id]);
    } finally {
      for (const stmt of sqlStatements(readFileSync(MIGRATION, 'utf8'))) await exec(stmt);
    }
  });

  it('cascades with the project', async () => {
    await svc.append(OTHER_SLUG, { title: 'doomed' }, { hostId: hostA.id });
    await new ProjectsService(db).deleteBySlug(OTHER_SLUG);
    const left = rowsOf(
      await exec(
        `SELECT COUNT(*) AS n FROM coord_project_changelog c
          LEFT JOIN coord_projects p ON p.id = c.project_id WHERE p.id IS NULL`,
      ),
    );
    expect(Number(left[0]!['n'])).toBe(0);
  });
});

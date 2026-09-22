import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { HostProjectsService } from '../../../src/services/host-projects.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import type { Host } from '../../../src/db/schema.js';

/**
 * The half of the lean read paths `db-fake` cannot reach.
 *
 * `fetchFileSummaries` asks MySQL for `octet_length(content)` instead of
 * selecting the body and measuring it in JS — that is the difference between a
 * listing that ships 424 KB of LONGTEXT and one that ships a few hundred bytes.
 * The fake discards the projection passed to `select()` and returns whole rows,
 * so there it evaluates to nothing and every file reports 0 bytes. Only a real
 * database can say whether the number is right.
 *
 * CI runs without a database, so this skips there. Run it with:
 *
 *   npm run test:db
 */

const SLUG = 'ztest-lean-reads';
const FQDN = 'ztest-lean.example';

const handle = await getTestDb();

describe.skipIf(!handle)('lean project reads against a real database', () => {
  let db: TestDb;
  let svc: HostProjectsService;
  let host: Host;

  const exec = async (q: string) => db.execute(sql.raw(q));
  const rowsOf = (res: unknown): Array<Record<string, unknown>> => {
    const first = Array.isArray(res) ? (res[0] as unknown) : res;
    return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
  };
  const cleanup = async () => {
    await exec(`DELETE FROM coord_projects WHERE slug = '${SLUG}'`);
    await exec(`DELETE FROM hosts WHERE fqdn = '${FQDN}'`);
  };

  // A multi-byte body: `octet_length` counts bytes and `CHAR_LENGTH` counts
  // characters, and picking the wrong one is exactly the bug this guards.
  const ASCII = 'a'.repeat(50_000);
  const UNICODE = 'ü'.repeat(1_000); // 1000 chars, 2000 bytes in utf8mb4

  beforeAll(async () => {
    db = handle!.db;
    await cleanup();
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO hosts (fqdn, api_key, status, created_at, updated_at)
       VALUES ('${FQDN}', SHA2('${FQDN}', 256), 'active', '${now}', '${now}')`,
    );
    host = rowsOf(await exec(`SELECT id, fqdn FROM hosts WHERE fqdn = '${FQDN}'`))[0] as unknown as Host;

    svc = new HostProjectsService(db);
    await svc.createProject({ slug: SLUG }, host);
    await svc.upsertFile(SLUG, { stored_name: 'context/big.md', content: ASCII }, host);
    await svc.upsertFile(SLUG, { stored_name: 'context/umlaut.md', content: UNICODE }, host);
  });

  afterAll(async () => {
    await cleanup();
    await handle?.pool.end();
  });

  it('reports byte-accurate sizes without shipping the bodies', async () => {
    const out = (await svc.listFileSummaries(SLUG, host)) as {
      files: Record<string, unknown>[];
    };
    const byName = new Map(out.files.map((f) => [String(f['stored_name']), f]));

    expect(byName.get('context/big.md')!['size_bytes']).toBe(ASCII.length);
    // Bytes, not characters: 1000 two-byte code points.
    expect(byName.get('context/umlaut.md')!['size_bytes']).toBe(2_000);

    for (const file of out.files) expect(file).not.toHaveProperty('content');
    expect(JSON.stringify(out).length).toBeLessThan(1_000);
  });

  it('agrees with the size the full read derives, so the two paths cannot drift', async () => {
    const lean = (await svc.listFileSummaries(SLUG, host)) as { files: Record<string, unknown>[] };
    for (const summary of lean.files) {
      const { file } = await svc.readFile(SLUG, { storedName: String(summary['stored_name']) }, host);
      expect(summary['size_bytes']).toBe(file.size_bytes);
      expect(summary['content_sha256']).toBe(file.content_sha256);
    }
  });

  it('windows a body and reassembles it byte-for-byte', async () => {
    let offset = 0;
    const chunks: Buffer[] = [];
    let guard = 0;
    for (;;) {
      if (++guard > 100) throw new Error('window walk did not terminate');
      const { file } = await svc.readFile(SLUG, { storedName: 'context/big.md', offset, limit: 8_192 }, host);
      chunks.push(Buffer.from(file.content, 'utf8'));
      if (!file.truncated) break;
      offset = file.next_offset!;
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(ASCII);
  });

  it('counts stored bytes without carrying them', async () => {
    const out = await svc.summary(SLUG, {}, host);
    expect((out['counts'] as Record<string, unknown>)['files_bytes']).toBe(ASCII.length + 2_000);
    // Most of what is left is the fixed CoCo guidance block, not project data.
    expect(JSON.stringify(out).length).toBeLessThan(6_000);
  });

  it('does not grow when the artifacts do — the property the byte budget is a proxy for', async () => {
    const before = JSON.stringify(await svc.summary(SLUG, {}, host)).length;
    await svc.upsertFile(SLUG, { stored_name: 'context/huge.md', content: 'z'.repeat(500_000) }, host);
    const after = JSON.stringify(await svc.summary(SLUG, {}, host)).length;

    // Half a megabyte of new content buys one metadata row and one event row —
    // about 700 bytes, three orders of magnitude below what was stored.
    // `project_detail` on the same project would now be ~550 KB.
    expect(after - before).toBeLessThan(1_000);
    expect((await svc.summary(SLUG, {}, host))['counts']).toMatchObject({
      files: 3,
      files_bytes: ASCII.length + 2_000 + 500_000,
    });
  });
});

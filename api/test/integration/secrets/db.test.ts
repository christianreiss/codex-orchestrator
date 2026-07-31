import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { SecretsService } from '../../../src/services/secrets.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../../../src/util/engine.js';
import type { Host } from '../../../src/db/schema.js';

/**
 * The only tests that exercise the fleet secrets store against real MySQL.
 *
 * Four claims live here and nowhere else, because `db-fake` cannot express any
 * of them:
 *
 *  1. `value_enc` never reaches a list response. The fake ignores `select(fields)`
 *     and hands back whole seeded rows, so the SQL column list is untested there
 *     — only `toMetadata` is. Here both halves run.
 *  2. Engine visibility (`engine IS NULL OR engine = ?`). The fake degrades any
 *     `or(...)` where-clause to a loose scan that drops the `IS NULL` side, so a
 *     unit assertion would either pass vacuously or fail for the fake's reasons.
 *  3. Slug uniqueness, including the case-insensitivity that
 *     `utf8mb4_unicode_ci` gives the unique key. The fake enforces no index.
 *  4. Migration idempotency and the index inventory.
 *
 * CI runs the unit tier without a database, so this file skips there. Run it:
 *
 *   npm run test:db          (TEST_USE_DB=1 + DB_* env)
 *
 * The suite applies `0010_add_secrets.sql` itself through the production
 * splitter (`src/db/migration-sql.ts`), so it is self-sufficient and cannot pass
 * against a cut of the SQL the real runner would never produce.
 */

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/db/migrations/0010_add_secrets.sql',
);

const FQDN = 'ztest-secrets.example';
const PLAINTEXT = 'ghp_live_credential_value';

const handle = await getTestDb();

describe.skipIf(!handle)('fleet secrets against a real database', () => {
  let db: TestDb;
  let svc: SecretsService;
  let host: Host;
  const logged: Array<{ method: string; name: string | null; success: boolean }> = [];

  const exec = async (q: string) => db.execute(sql.raw(q));
  const rowsOf = (res: unknown): Array<Record<string, unknown>> => {
    const first = Array.isArray(res) ? (res[0] as unknown) : res;
    return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
  };
  const cleanup = async () => {
    await exec(`DELETE FROM secrets WHERE slug LIKE 'ztest-%'`);
    await exec(`DELETE FROM versions WHERE name = 'secrets_module_enabled'`);
    await exec(`DELETE FROM mcp_access_logs WHERE method = 'secret.read'`);
    await exec(`DELETE FROM hosts WHERE fqdn = '${FQDN}'`);
  };

  beforeAll(async () => {
    db = handle!.db;
    for (const stmt of splitSqlStatements(readFileSync(MIGRATION, 'utf8'))) await exec(stmt);
    await cleanup();

    const now = new Date().toISOString();
    await exec(
      `INSERT INTO hosts (fqdn, api_key, status, created_at, updated_at)
       VALUES ('${FQDN}', SHA2('${FQDN}', 256), 'active', '${now}', '${now}')`,
    );
    host = rowsOf(
      await exec(`SELECT id, fqdn FROM hosts WHERE fqdn = '${FQDN}'`),
    )[0] as unknown as Host;

    const accessLog = {
      log: async (entry: { method: string; name: string | null; success: boolean }) => {
        logged.push(entry);
        await db.execute(
          sql`INSERT INTO mcp_access_logs (host_id, client_ip, method, name, success, error_code, error_message, created_at, engine)
              VALUES (${host.id}, NULL, ${entry.method}, ${entry.name}, ${entry.success ? 1 : 0}, NULL, NULL, ${now}, ${ENGINE_CODEX})`,
        );
      },
    };
    svc = new SecretsService({ db, keyring: testKeyring(), accessLog: accessLog as never });
    await svc.setEnabled(true);
  });

  afterAll(async () => {
    await cleanup();
    await handle?.pool.end();
  });

  describe('migration', () => {
    it('is idempotent and declares every index', async () => {
      // Re-applying is what the shipped runner does against an already-migrated
      // database; it must be a no-op, not an error.
      for (const stmt of splitSqlStatements(readFileSync(MIGRATION, 'utf8'))) await exec(stmt);

      const names = rowsOf(
        await exec(
          `SELECT DISTINCT INDEX_NAME AS n FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'secrets'`,
        ),
      ).map((row) => String(row['n']));

      expect(names).toContain('uniq_secrets_slug');
      expect(names).toContain('idx_secrets_engine');
      expect(names).toContain('idx_secrets_updated_at');
      expect(names).toContain('idx_secrets_deleted_at');
    });
  });

  describe('ciphertext containment', () => {
    it('stores an sbox envelope that never appears in any read path', async () => {
      const created = await svc.create({
        slug: 'ztest-gh-pat',
        name: 'GitHub PAT',
        value: PLAINTEXT,
      });

      // The ciphertext is genuinely in the table...
      const stored = rowsOf(
        await exec(`SELECT value_enc FROM secrets WHERE slug = 'ztest-gh-pat'`),
      );
      expect(String(stored[0]!['value_enc'])).toMatch(/^sbox:v1:/);
      expect(String(stored[0]!['value_enc'])).not.toContain(PLAINTEXT);

      // ...and reaches no metadata surface. This is the assertion the fake
      // cannot make, since it ignores the SELECT column list entirely.
      for (const result of [
        await svc.list(),
        await svc.search('ztest'),
        [await svc.findById(created.id)],
        [await svc.findBySlug('ztest-gh-pat')],
      ]) {
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('sbox:');
        expect(serialized).not.toContain('value_enc');
        expect(serialized).not.toContain(PLAINTEXT);
      }

      expect((await svc.revealById(created.id)).value).toBe(PLAINTEXT);
    });
  });

  describe('engine visibility in SQL', () => {
    beforeAll(async () => {
      await svc.create({ slug: 'ztest-shared', name: 'shared', value: 'v' });
      await svc.create({ slug: 'ztest-codex', name: 'codex', value: 'v', engine: ENGINE_CODEX });
      await svc.create({ slug: 'ztest-claude', name: 'claude', value: 'v', engine: ENGINE_CLAUDE });
    });

    it('shows null-engine rows to both engines and scoped rows to only one', async () => {
      const slugs = async (engine: typeof ENGINE_CODEX | typeof ENGINE_CLAUDE | null) =>
        (await svc.list({ engine })).map((s) => s.slug).filter((s) => s.startsWith('ztest-'));

      expect(await slugs(ENGINE_CODEX)).toEqual(['ztest-codex', 'ztest-gh-pat', 'ztest-shared']);
      expect(await slugs(ENGINE_CLAUDE)).toEqual(['ztest-claude', 'ztest-gh-pat', 'ztest-shared']);
      expect(await slugs(null)).toEqual([
        'ztest-claude',
        'ztest-codex',
        'ztest-gh-pat',
        'ztest-shared',
      ]);
    });

    it('refuses a cross-engine get and still writes the audit row', async () => {
      const before = logged.length;
      await expect(svc.getForHost('ztest-claude', host, ENGINE_CODEX)).rejects.toThrow();

      expect(logged.slice(before)).toMatchObject([
        { method: 'secret.read', name: 'secret_get:ztest-claude', success: false },
      ]);
      const audited = rowsOf(
        await exec(
          `SELECT name, success FROM mcp_access_logs
            WHERE method = 'secret.read' AND name = 'secret_get:ztest-claude'`,
        ),
      );
      expect(audited).toHaveLength(1);
      expect(Number(audited[0]!['success'])).toBe(0);
      // The audit column is VARCHAR(128); the slug cap of 96 is what keeps
      // `secret_get:<slug>` from truncating.
      expect(String(audited[0]!['name']).length).toBeLessThanOrEqual(128);
    });

    it('serves a matching-engine get and audits the success', async () => {
      const payload = await svc.getForHost('ztest-codex', host, ENGINE_CODEX);
      expect(payload.value).toBe('v');

      const audited = rowsOf(
        await exec(
          `SELECT success FROM mcp_access_logs
            WHERE method = 'secret.read' AND name = 'secret_get:ztest-codex'`,
        ),
      );
      expect(audited).toHaveLength(1);
      expect(Number(audited[0]!['success'])).toBe(1);
    });
  });

  describe('slug uniqueness', () => {
    // Drizzle wraps the driver error, so the ER_DUP_ENTRY text lives on the
    // cause chain rather than the message. Assert the outcome that actually
    // matters — the row did not land — instead of matching a wrapper string.
    const insertDupe = async (slug: string) => {
      const now = new Date().toISOString();
      await exec(
        `INSERT INTO secrets (slug, name, value_enc, created_at, updated_at)
         VALUES ('${slug}', 'dupe', 'sbox:v1:x', '${now}', '${now}')`,
      );
    };
    const countLike = async (slug: string) =>
      Number(
        rowsOf(await exec(`SELECT COUNT(*) AS c FROM secrets WHERE slug = '${slug}'`))[0]!['c'],
      );

    it('rejects a duplicate at the database level', async () => {
      await expect(insertDupe('ztest-shared')).rejects.toThrow();
      expect(await countLike('ztest-shared')).toBe(1);
    });

    it('collides case-insensitively under utf8mb4_unicode_ci', async () => {
      // Which is exactly why the service lower-cases every slug on write: the
      // constraint and the lookup have to agree, and here they would not.
      await expect(insertDupe('ZTest-Shared')).rejects.toThrow();
      expect(await countLike('ztest-shared')).toBe(1);
    });
  });

  describe('soft delete and revival', () => {
    it('hides the row, refuses reads, and lets a create revive the slug', async () => {
      const created = await svc.create({ slug: 'ztest-cycle', name: 'cycle', value: 'first' });
      await svc.softDelete(created.id);

      expect((await svc.list()).map((s) => s.slug)).not.toContain('ztest-cycle');
      expect(await svc.findBySlug('ztest-cycle')).toBeNull();
      await expect(svc.getForHost('ztest-cycle', host, ENGINE_CODEX)).rejects.toThrow();
      expect(
        (await svc.list({ includeDeleted: true })).map((s) => s.slug),
      ).toContain('ztest-cycle');

      // The unique key is on slug alone, so a soft-deleted row still owns it.
      // Creating must revive rather than hit ER_DUP_ENTRY.
      const revived = await svc.create({ slug: 'ztest-cycle', name: 'cycle again', value: 'second' });
      expect(revived.id).toBe(created.id);
      expect(revived.deletedAt).toBeNull();
      expect((await svc.revealById(revived.id)).value).toBe('second');
    });
  });

  describe('search', () => {
    it('escapes LIKE metacharacters against real MySQL', async () => {
      // Unescaped, `%` would match every row and read as "the store holds
      // everything you asked for".
      expect(await svc.search('%')).toEqual([]);
      expect(await svc.search('_')).toEqual([]);
      expect((await svc.search('ztest-shared')).map((s) => s.slug)).toEqual(['ztest-shared']);
    });
  });

  describe('module switch', () => {
    it('stops serving host reads while off, without touching admin reads', async () => {
      await svc.setEnabled(false);
      expect(await svc.getEnabled()).toBe(false);
      expect(await svc.listForHost(ENGINE_CODEX)).toEqual([]);
      await expect(svc.getForHost('ztest-shared', host, ENGINE_CODEX)).rejects.toThrow();
      // Admin CRUD stays live so secrets can be staged before switch-on.
      expect((await svc.list()).length).toBeGreaterThan(0);

      await svc.setEnabled(true);
      expect((await svc.listForHost(ENGINE_CODEX)).length).toBeGreaterThan(0);
    });
  });
});

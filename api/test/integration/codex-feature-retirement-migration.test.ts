import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { ClientConfigService } from '../../src/services/client-config.js';
import { inArray } from 'drizzle-orm';
import { clientConfigDocuments } from '../../src/db/schema.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
const table = 'codex_retirement_test_documents';
const savedIds: number[] = [];

describe.skipIf(!handle)('Codex shell_zsh_fork data migration', () => {
  afterAll(async () => {
    if (!handle) return;
    await handle.pool.query(`DROP TABLE IF EXISTS ${table}`);
    if (savedIds.length) await handle.db.delete(clientConfigDocuments).where(inArray(clientConfigDocuments.id, savedIds));
    await handle.pool.end();
  });

  it('migrates root/profile structured/native settings twice, preserving siblings, exact keys and other engines', async () => {
    const db = await handle!.pool.getConnection();
    try {
      await db.query(`DROP TABLE IF EXISTS ${table}`);
      await db.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, engine VARCHAR(20), settings JSON, body TEXT, sha256 VARCHAR(64))`);
      const legacy = {
        features: { shell_zsh_fork: true, hooks: false },
        native_settings: { features: { shell_zsh_fork: false, credential_masking: true },
          mcp_servers: { 'features.shell_zsh_fork': { command: '/bin/echo' } } },
        profiles: [
          { name: 'first', features: { shell_zsh_fork: true, hooks: true }, native_settings: { features: { shell_zsh_fork: false, async_compaction: false } } },
          { name: 'second', native_settings: { features: { shell_zsh_fork: true, hooks: false } } },
          { name: 'untouched', native_settings: { notify: ['/bin/echo'] } },
        ],
      };
      const expected = structuredClone(legacy);
      delete (expected.features as Record<string, unknown>).shell_zsh_fork;
      delete (expected.native_settings.features as Record<string, unknown>).shell_zsh_fork;
      for (const profile of expected.profiles) {
        if (profile.features) delete (profile.features as Record<string, unknown>).shell_zsh_fork;
        if (profile.native_settings.features) delete (profile.native_settings.features as Record<string, unknown>).shell_zsh_fork;
      }
      for (const [id, engine, settings] of [[1, 'codex', legacy], [2, 'claude', legacy],
        [3, 'grok', legacy], [4, 'codex', { profiles: 'opaque' }], [5, 'codex', null]] as const) {
        await db.query(`INSERT INTO ${table} VALUES (?, ?, ?, 'historical body', 'historical digest')`, [id, engine, settings === null ? null : JSON.stringify(settings)]);
      }
      const migration = (await readFile(new URL('../../src/db/migrations/0071_retire_codex_shell_zsh_fork.sql', import.meta.url), 'utf8'))
        .replaceAll('client_config_documents', table);
      for (let run = 0; run < 2; run++) {
        for (const statement of splitSqlStatements(migration)) await db.query(statement);
        const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${table} ORDER BY id`);
        const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;
        expect(json(rows[0]!.settings)).toEqual(expected);
        expect(json(rows[1]!.settings)).toEqual(legacy);
        expect(json(rows[2]!.settings)).toEqual(legacy);
        expect(json(rows[3]!.settings)).toEqual({ profiles: 'opaque' });
        expect(rows[4]!.settings).toBeNull();
        for (const row of rows) expect(row).toMatchObject({ body: 'historical body', sha256: 'historical digest' });
        const rendered = new ClientConfigService({} as never).render(json(rows[0]!.settings));
        expect(rendered.content).not.toMatch(/^shell_zsh_fork =/m);
        expect(rendered.content).toContain('[mcp_servers."features.shell_zsh_fork"]');
        expect(rendered.profiles?.every(profile => !/^shell_zsh_fork =/m.test(profile.content))).toBe(true);
        const [inserted] = await handle!.db.insert(clientConfigDocuments).values({
          engine: 'codex', settings: json(rows[0]!.settings), body: 'historical body',
          sha256: '0'.repeat(64), createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z',
        });
        savedIds.push(inserted.insertId);
        const service = new ClientConfigService(handle!.db);
        const fetched = await service.adminFetch();
        expect(fetched.settings?.native_settings).toEqual(expected.native_settings);
        expect(fetched.content).toBe('historical body');
        const saved = await service.store({ settings: fetched.settings, expected_revision: fetched.revision });
        savedIds.push(Number(saved.revision));
        expect(saved.change).toBe('updated');
        expect(saved.revision).not.toBe(fetched.revision);
        expect(saved.content).toBe(rendered.content);
        expect(saved.sha256).toBe(rendered.sha256);
        await expect(service.store({ settings: fetched.settings, expected_revision: fetched.revision })).rejects.toThrow(/changed since/);
      }
    } finally { db.release(); }
  });
});

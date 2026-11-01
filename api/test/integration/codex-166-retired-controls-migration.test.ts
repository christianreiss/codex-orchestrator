import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { ClientConfigService } from '../../src/services/client-config.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
const table = 'codex_0166_retirement_test_documents';

describe.skipIf(!handle)('Codex 0.166 retired controls migration', () => {
  afterAll(async () => {
    if (!handle) return;
    await handle.pool.query(`DROP TABLE IF EXISTS ${table}`);
    await handle.pool.end();
  });
  it('heals every exact root/profile path twice and preserves siblings, literal names, other engines and history', async () => {
    const db = await handle!.pool.getConnection();
    const features = { code_mode_tool_description_first: false, hooks: false,
      guardianv2: { async_classifier_mode: 'snapshot', enabled: false, async_classifier_conversation_token_limit: 1 } };
    const native = { features: { ...structuredClone(features), code_mode_tool_description_first: true },
      mcp_servers: { 'features.code_mode_tool_description_first': { command: '/bin/echo' } },
      plugins: { 'guardianv2.async_classifier_mode@test': { enabled: false } } };
    const legacy = { features, native_settings: native, profiles: [
      { name: 'first', features: structuredClone(features), native_settings: structuredClone(native) },
      { name: 'second', features: { code_mode_tool_description_first: true, guardianv2: { async_classifier_mode: 'conversation', enabled: false } } },
      { name: 'untouched', native_settings: { notify: ['/bin/echo'] } },
    ] };
    const expected = structuredClone(legacy);
    const strip = (value: unknown) => {
      const record = value as { features?: Record<string, unknown> };
      if (!record?.features) return;
      delete record.features.code_mode_tool_description_first;
      if (record.features.guardianv2) delete (record.features.guardianv2 as Record<string, unknown>).async_classifier_mode;
    };
    strip(expected); strip(expected.native_settings);
    for (const profile of expected.profiles) { strip(profile); strip(profile.native_settings); }
    const body = 'historical authored TOML\ncode_mode_tool_description_first = false';
    const sha = createHash('sha256').update(body).digest('hex');
    try {
      await db.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, engine VARCHAR(20), settings JSON, body TEXT, sha256 VARCHAR(64), updated_at VARCHAR(30))`);
      const fixtures = [['codex', legacy], ['claude', legacy], ['grok', legacy], ['codex', { profiles: 'opaque' }], ['codex', null]] as const;
      for (const [index, [engine, settings]] of fixtures.entries()) {
        await db.query(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?)`, [index, engine, settings === null ? null : JSON.stringify(settings), body, sha, '2026-11-01T00:00:00Z']);
      }
      const migration = (await readFile(new URL('../../src/db/migrations/0121_codex_166_retired_controls.sql', import.meta.url), 'utf8')).replaceAll('client_config_documents', table);
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of splitSqlStatements(migration)) await db.query(statement);
        const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${table} ORDER BY id`);
        const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;
        expect(json(rows[0]!.settings)).toEqual(expected);
        expect(json(rows[1]!.settings)).toEqual(legacy);
        expect(json(rows[2]!.settings)).toEqual(legacy);
        expect(json(rows[3]!.settings)).toEqual({ profiles: 'opaque' });
        expect(rows[4]!.settings).toBeNull();
        for (const row of rows) expect(row).toMatchObject({ body, sha256: sha, updated_at: '2026-11-01T00:00:00Z' });
        const rendered = new ClientConfigService({} as never).render(json(rows[0]!.settings));
        for (const content of [rendered.content, ...rendered.profiles!.map(profile => profile.content)]) {
          expect(content).not.toMatch(/^(code_mode_tool_description_first|async_classifier_mode) =/m);
        }
        expect(rendered.content).toContain('[mcp_servers."features.code_mode_tool_description_first"]');
        expect(rendered.profiles?.map(profile => profile.name)).toEqual(['first', 'second', 'untouched']);
        expect(rendered.content).toContain('async_classifier_conversation_token_limit = 1');
      }
    } finally { db.release(); }
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
const table = 'claude_0323_retirement_test_documents';
describe.skipIf(!handle)('Claude 2.1.323 removed status line migration', () => {
  afterAll(async () => {
    if (!handle) return;
    await handle.pool.query(`DROP TABLE IF EXISTS ${table}`);
    await handle.pool.end();
  });
  it('removes only the exact Claude root leaf twice, preserving siblings, other engines and history', async () => {
    const legacy = {
      native_settings: {
        subagentStatusLine: { type: 'command', command: 'old' },
        statusLine: { type: 'command', command: 'keep' },
        env: { subagentStatusLine: 'literal', 'native_settings.subagentStatusLine': 'dotted' },
        unknownFutureField: { subagentStatusLine: true },
      },
      subagentStatusLine: 'wrong scope preserved',
      'native_settings.subagentStatusLine': 'literal root preserved',
    };
    const expected = structuredClone(legacy);
    Reflect.deleteProperty(expected.native_settings, 'subagentStatusLine');
    const fixtures = [
      ['claude', legacy],
      ['codex', legacy],
      ['grok', legacy],
      ['kimi', legacy],
      ['claude', { native_settings: null }],
      ['claude', { native_settings: 'opaque' }],
      ['claude', null],
      ['claude', { native_settings: { subagentStatusLine: null, language: 'german' } }],
      ['claude', { native_settings: { env: { subagentStatusLine: 'literal only' } } }],
    ] as const;
    const body = '{"subagentStatusLine":{"type":"command","command":"old"}}';
    const sha = createHash('sha256').update(body).digest('hex');
    await handle!.pool.query(
      `CREATE TABLE ${table} (id INT PRIMARY KEY, engine VARCHAR(20), settings JSON, body TEXT, sha256 VARCHAR(64), updated_at VARCHAR(30))`,
    );
    for (const [id, [engine, settings]] of fixtures.entries()) {
      await handle!.pool.query(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?)`, [
        id,
        engine,
        settings === null ? null : JSON.stringify(settings),
        body,
        sha,
        '2026-11-01T00:00:00Z',
      ]);
    }
    const migration = (
      await readFile(
        new URL('../../src/db/migrations/0133_claude_323_removed_status_line.sql', import.meta.url),
        'utf8',
      )
    ).replaceAll('client_config_documents', table);
    for (let pass = 0; pass < 2; pass++) {
      for (const statement of splitSqlStatements(migration)) await handle!.pool.query(statement);
      const [rows] = await handle!.pool.query<RowDataPacket[]>(`SELECT * FROM ${table} ORDER BY id`);
      const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
      const expectedSettings = fixtures.map(([, settings]) => settings);
      expectedSettings[0] = expected;
      expectedSettings[7] = { native_settings: { language: 'german' } } as never;
      expect(rows.map((row) => json(row.settings))).toEqual(expectedSettings);
      for (const row of rows)
        expect(row).toMatchObject({ body, sha256: sha, updated_at: '2026-11-01T00:00:00Z' });
    }
  });
});

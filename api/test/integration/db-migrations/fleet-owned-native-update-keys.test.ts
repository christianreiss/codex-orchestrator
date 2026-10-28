import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { getTestDb } from '../../helpers/test-db.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import { ClientConfigService } from '../../../src/services/client-config.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Fleet-owned native update keys migration (0115)', () => {
  afterAll(async () => { await handle?.pool.end(); });
  it('removes exact update-policy/inert paths idempotently from root and layers, preserving siblings, other engines and snapshots', async () => {
    const pool = handle!.pool;
    const grok = { model: 'grok-4.7', native_settings: {
      cli: { required_minimum_version: '9.9.9', channel: 'alpha', npm_registry: 'https://registry.invalid', auto_update: false, show_tips: false },
      compat: { claude: { sessions: true, skills: false }, cursor: { sessions: false } },
      features: { zdr_access_enabled: true },
      mcp_servers: { 'cli.channel': { command: '/bin/echo' } },
      version_overrides: [
        { maximum_version: '1.0.63', cli: { required_maximum_version: '1.0.63', installer: 'npm' }, compat: { codex: { sessions: true } } },
        { minimum_version: '1.0.70', cli: { minimum_version: '1.0.70', maximum_version: '1.0.80' }, ui: { theme: 'keep' } },
      ],
    } };
    const grokExpected = { model: 'grok-4.7', native_settings: {
      cli: { auto_update: false, show_tips: false },
      compat: { claude: { skills: false }, cursor: {} },
      features: { zdr_access_enabled: true },
      mcp_servers: { 'cli.channel': { command: '/bin/echo' } },
      version_overrides: [
        { maximum_version: '1.0.63', cli: {}, compat: { codex: {} } },
        { minimum_version: '1.0.70', cli: {}, ui: { theme: 'keep' } },
      ],
    } };
    const claude = { model: 'claude-sonnet-5', native_settings: { minimumVersion: '2.1.300', language: 'german' } };
    const claudeExpected = { model: 'claude-sonnet-5', native_settings: { language: 'german' } };
    const body = 'historical update keys', sha = createHash('sha256').update(body).digest('hex');
    const ids: number[] = [];
    try {
      for (const [engine, settings] of [['grok', grok], ['claude', claude], ['codex', grok]] as const) {
        const [result] = await pool.execute('INSERT INTO client_config_documents (engine, settings, body, sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [engine, JSON.stringify(settings), body, sha, '2026-10-28T00:00:00Z', '2026-10-28T00:00:00Z']);
        ids.push((result as { insertId: number }).insertId);
      }
      const statements = splitSqlStatements(await readFile(new URL('../../../src/db/migrations/0115_fleet_owned_native_update_keys.sql', import.meta.url), 'utf8'));
      const conn = await pool.getConnection();
      try {
        for (let pass = 0; pass < 2; pass++) {
          for (const statement of statements) await conn.query(statement);
          const [rows] = await conn.query<RowDataPacket[]>('SELECT id, settings, body, sha256, updated_at FROM client_config_documents WHERE id IN (?) ORDER BY id', [ids]);
          expect(rows.map(row => row.settings)).toEqual([grokExpected, claudeExpected, grok]);
          for (const row of rows) expect(row).toMatchObject({ body, sha256: sha, updated_at: '2026-10-28T00:00:00Z' });
        }
      } finally { conn.release(); }
      const configs = new ClientConfigService(handle!.db);
      expect(configs.render(grokExpected, 'grok').content).not.toMatch(/required_minimum_version|sessions/);
      expect(() => configs.render(claudeExpected, 'claude')).not.toThrow();
    } finally { if (ids.length) await pool.query('DELETE FROM client_config_documents WHERE id IN (?)', [ids]); }
  });
});

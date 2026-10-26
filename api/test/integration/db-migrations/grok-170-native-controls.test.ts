import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { getTestDb } from '../../helpers/test-db.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import { ClientConfigService } from '../../../src/services/client-config.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Grok 1.0.70 stored native controls migration', () => {
  afterAll(async () => { await handle?.pool.end(); });
  it('migrates exact retired paths idempotently across version layers and preserves snapshots and literal names', async () => {
    const pool = handle!.pool;
    const opaque = 'custom.with.dot"and\\slash';
    const source = { native_settings: {
      keys: { vim: 'off' },
      ui: { vim_mode: true, simple_mode: false, collapsed_edit_blocks: true, group_tool_verbs: false, theme: 'keep' },
      memory_v2: { compact_index_enabled: true, batch_dream_enabled: false },
      model: { [opaque]: { compaction_at_tokens: {}, compactions_remaining: 'all', vision: false, extra_headers: { 'X.Team': 'keep' } }, other: { compaction_at_tokens: 100, compactions_remaining: 0 } },
      version_overrides: [
        { minimum_version: '1.0.68', ui: { vim_mode: false, collapsed_edit_blocks: false, group_tool_verbs: true }, memory_v2: { compact_index_enabled: false } },
        { ui: { tool_call_density: 'detailed', group_tool_verbs: false, collapsed_edit_blocks: true } },
        { ui: { group_tool_verbs: true } },
        { keys: { vim: 'bad' }, ui: { vim_mode: true, group_tool_verbs: false } },
      ],
    } };
    const expected = { native_settings: {
      keys: { vim: 'off' }, ui: { theme: 'keep', tool_call_density: 'compact-ungrouped' }, memory_v2: { batch_dream_enabled: false },
      model: { [opaque]: { vision: false, extra_headers: { 'X.Team': 'keep' } }, other: { compaction_at_tokens: 100, compactions_remaining: 0 } },
      version_overrides: [
        { minimum_version: '1.0.68', keys: { vim: 'off' }, ui: { tool_call_density: 'compact-shells' }, memory_v2: {} },
        { ui: { tool_call_density: 'detailed' } }, { ui: {} },
        { keys: { vim: 'nav' }, ui: { tool_call_density: 'compact-shells' } },
      ],
    } };
    const body = 'historical retired values', sha = createHash('sha256').update(body).digest('hex');
    const ids: number[] = [];
    try {
      for (const engine of ['grok', 'claude']) {
        const [result] = await pool.execute('INSERT INTO client_config_documents (engine, settings, body, sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [engine, JSON.stringify(source), body, sha, '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z']);
        ids.push((result as { insertId: number }).insertId);
      }
      const statements = splitSqlStatements(await readFile(new URL('../../../src/db/migrations/0110_grok_170_native_controls.sql', import.meta.url), 'utf8'));
      const conn = await pool.getConnection();
      try {
        for (let pass = 0; pass < 2; pass++) {
          for (const statement of statements) await conn.query(statement);
          const [rows] = await conn.query<RowDataPacket[]>('SELECT settings, body, sha256, updated_at FROM client_config_documents WHERE id = ?', [ids[0]]);
          expect(rows[0]).toEqual({ settings: expected, body, sha256: sha, updated_at: '2026-10-26T00:00:00Z' });
          const [others] = await conn.query<RowDataPacket[]>('SELECT settings FROM client_config_documents WHERE id = ?', [ids[1]]);
          expect(others[0]?.settings).toEqual(source);
        }
      } finally { conn.release(); }
      const configs = new ClientConfigService(handle!.db);
      const fetched = await configs.adminFetch('grok');
      expect(fetched.settings?.native_settings).toEqual(expected.native_settings);
      expect(fetched.content).toBe(body);
      const preview = configs.render(fetched.settings, 'grok');
      expect(preview.content).not.toContain('vim_mode');
      expect(preview.content).not.toContain('compact_index_enabled');
      expect(preview.content).toContain('tool_call_density = "compact-ungrouped"');
      const saved = await configs.store({ settings: fetched.settings, sha256: fetched.sha256, expected_revision: fetched.revision }, null, 'grok');
      ids.push(Number(saved.revision));
      expect(saved.sha256).toBe(createHash('sha256').update(saved.content).digest('hex'));
      await expect(configs.store({ settings: { native_settings: {} }, expected_revision: fetched.revision }, null, 'grok')).rejects.toMatchObject({ status: 409, code: 'config_revision_conflict' });
    } finally { if (ids.length) await pool.query('DELETE FROM client_config_documents WHERE id IN (?)', [ids]); }
  });
});

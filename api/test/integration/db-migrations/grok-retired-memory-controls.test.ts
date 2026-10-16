import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it, expect, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb();

describe.skipIf(!handle)('Grok removed memory controls migration', () => {
  afterAll(async () => { await handle?.pool.end(); });

  it('repairs only confirmed invalid native shapes and leaves unknown custom content actionable', async () => {
    const pool = handle!.pool;
    const customId = 'custom.with.dots"and\\slashes';
    const source = { native_settings: {
      shell_environment_policy: { inherit: 'audit', set: { KEEP: 'value' } },
      ui: { theme: 'grokday', status_line: { command: 'missing-type' } },
      model: {
        [customId]: { temperature: 0.4, 6: { api_key: 'inert' }, notice: {} },
        'kept.custom': { api_key: 'valid-custom', 6: { api_key: 'inert', unknown: true }, notice: { text: 'kept', severity: 'invalid', label: 'kept' } },
        'unknown.custom': { notice: { unknown: true } },
      },
      version_overrides: [
        { minimum_version: '1.0.60', shell_environment_policy: { inherit: 'invalid', exclude: ['KEEP'] }, ui: { status_line: { type: 'builtin', items: ['invalid', 'cwd', 'model'], padding: 2, refresh_interval: 10 } } },
        { ui: { status_line: { type: 'command' }, theme: 'groknight' } },
        { ui: { status_line: { type: 'builtin', items: [] } } },
        { ui: { status_line: { type: 'off' } }, shell_environment_policy: { inherit: 'none' } },
        { ui: { status_line: { command: 'unknown-shape', custom: true } } },
      ],
    } };
    const expected = { native_settings: {
      shell_environment_policy: { set: { KEEP: 'value' } },
      ui: { theme: 'grokday' },
      model: {
        [customId]: { temperature: 0.4 },
        'kept.custom': { api_key: 'valid-custom', 6: { unknown: true }, notice: { text: 'kept', label: 'kept' } },
        'unknown.custom': { notice: { unknown: true } },
      },
      version_overrides: [
        { minimum_version: '1.0.60', shell_environment_policy: { exclude: ['KEEP'] }, ui: { status_line: { type: 'builtin', items: ['cwd', 'model'], padding: 2 } } },
        { ui: { theme: 'groknight' } },
        { ui: { status_line: { type: 'builtin' } } },
        { ui: { status_line: { type: 'off' } }, shell_environment_policy: { inherit: 'none' } },
        { ui: { status_line: { command: 'unknown-shape', custom: true } } },
      ],
    } };
    const body = 'historical-body';
    const sha = createHash('sha256').update(body).digest('hex');
    const [result] = await pool.execute('INSERT INTO client_config_documents (engine, settings, body, sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['grok', JSON.stringify(source), body, sha, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z']);
    const id = (result as { insertId: number }).insertId;
    const connection = await pool.getConnection();
    try {
      const statements = splitSqlStatements(await readFile(new URL('../../../src/db/migrations/0072_grok_retired_memory_controls.sql', import.meta.url), 'utf8'));
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of statements) await connection.query(statement);
        const [rows] = await connection.query<RowDataPacket[]>('SELECT settings, body, sha256 FROM client_config_documents WHERE id = ?', [id]);
        expect(rows[0]).toMatchObject({ settings: expected, body, sha256: sha });
      }
      const configs = new ClientConfigService(handle!.db);
      expect(() => configs.render(expected, 'grok')).toThrow('unknown Grok setting');
    } finally {
      connection.release();
      await pool.query('DELETE FROM client_config_documents WHERE id = ?', [id]);
    }
  });

  it('migrates known removed controls idempotently, preserving siblings, snapshots and other engines', async () => {
    const pool = handle!.pool;
    const source = { native_settings: {
      memory: { enabled: false, embedding: { dimensions: 128 }, initial_injection: { enabled: true }, search: { max_results: 10 }, session: { save_on_end: true }, watcher: { enabled: true } },
      memory_v2: { enabled: false, automatic_dream_enabled: true, capture_enabled: true, capture_status_enabled: false, file_writes_enabled: false, manual_dream_enabled: false, rollout: 'off', batch_dream_enabled: false, archived_retention_days: 30 },
      model: { 'custom.with.dots': { extra_headers: { 'X.Team': 'infra' }, notice: { text: 'Custom model', severity: 'info' } } },
      version_overrides: [{ minimum_version: '1.0.60', memory: { search: { min_score: 0.5 }, enabled: false }, memory_v2: { capture_enabled: false, batch_dream_enabled: false }, workflows: { enabled: false } }],
    } };
    const expected = { native_settings: {
      memory: { enabled: false },
      memory_v2: { enabled: false, batch_dream_enabled: false, archived_retention_days: 30 },
      model: source.native_settings.model,
      version_overrides: [{ minimum_version: '1.0.60', memory: { enabled: false }, memory_v2: { batch_dream_enabled: false }, workflows: { enabled: false } }],
    } };
    const historicalBody = '[memory.search]\nmax_results = 10\n';
    const historicalSha = createHash('sha256').update(historicalBody).digest('hex');
    const inserted: number[] = [];
    // A dedicated serial DB suite owns this fixture. Preserve all unrelated rows.
    try {
      for (const engine of ['grok', 'codex']) {
        const [result] = await pool.execute('INSERT INTO client_config_documents (engine, settings, body, sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [engine, JSON.stringify(source), historicalBody, historicalSha, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z']);
        inserted.push((result as { insertId: number }).insertId);
      }
      const migration = splitSqlStatements(await readFile(new URL('../../../src/db/migrations/0072_grok_retired_memory_controls.sql', import.meta.url), 'utf8'));
      const apply = async () => {
        const connection = await pool.getConnection();
        try { for (const statement of migration) await connection.query(statement); }
        finally { connection.release(); }
      };
      await apply();
      const read = async (id: number) => {
        const [rows] = await pool.query<RowDataPacket[]>('SELECT settings, body, sha256, updated_at FROM client_config_documents WHERE id = ?', [id]);
        return rows[0]!;
      };
      const first = await read(inserted[0]!);
      expect(first.settings).toEqual(expected);
      expect(first.body).toBe(historicalBody);
      expect(first.sha256).toBe(historicalSha);
      expect((await read(inserted[1]!)).settings).toEqual(source);
      await apply();
      expect(await read(inserted[0]!)).toEqual(first);

      const configs = new ClientConfigService(handle!.db);
      const fetched = await configs.adminFetch('grok');
      expect(fetched.content).toBe(historicalBody);
      expect(fetched.sha256).toBe(historicalSha);
      expect(fetched.settings?.native_settings).toEqual(expected.native_settings);
      const preview = configs.render(fetched.settings, 'grok');
      expect(preview.content).not.toContain('memory.search');
      expect(preview.content).not.toContain('capture_enabled');
      expect(preview.content).toContain('batch_dream_enabled = false');
      expect(preview.content).toContain('[model."custom.with.dots".extra_headers]');
      const saved = await configs.store({ settings: fetched.settings, sha256: fetched.sha256, expected_revision: fetched.revision }, null, 'grok');
      inserted.push(Number(saved.revision));
      expect(saved.content).toBe(preview.content);
      expect(saved.sha256).toBe(createHash('sha256').update(saved.content).digest('hex'));
      expect(saved.change).toBe('updated');
    } finally {
      if (inserted.length) await pool.query('DELETE FROM client_config_documents WHERE id IN (?)', [inserted]);
    }
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { migrateStoredKimiNativeSettings } from '../../src/services/kimi-native-settings.js';
import { getTestDb } from '../helpers/test-db.js';
const handle = await getTestDb();
const table = 'kimi_retirement_test_documents';
describe.skipIf(!handle)('Kimi 2.6 native retirement data migration', () => {
  afterAll(async () => {
    if (!handle) return;
    await handle.pool.query(`DROP TABLE IF EXISTS ${table}`);
    await handle.pool.end();
  });
  it('matches stored healing twice, preserving siblings, literal names, explicit successors and historical snapshots', async () => {
    const db = await handle!.pool.getConnection();
    try {
      await db.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, engine VARCHAR(20), settings JSON, body TEXT, sha256 VARCHAR(64))`);
      const samples = [
        { loop_control: { max_retries_per_step: 4, max_steps_per_run: 0, reserved_context_size: 99 }, secondary_model: { force: true, max_context_size: 100, max_input_size: 100, max_output_size: 100, capabilities: ['thinking'], display_name: 'old', reasoning_key: 'old', adaptive_thinking: true, support_efforts: ['high'], off_effort: 'none', default_model: 'my.model', default_effort: 'high' }, task: { max_running_tasks: 1, kill_grace_period_ms: 1000 }, background: { max_running_tasks: 2 }, models: { 'secondary_model.force': { model: 'literal', overrides: { max_context_size: 100 } } } },
        { loop_control: { max_retries_per_step: 1, max_attempts_per_step: 7, max_steps_per_run: 1, max_steps_per_turn: 8 } },
        { loop_control: { max_retries_per_step: -1, max_steps_per_run: 'invalid' }, thinking: { unknown: true } },
        { loop_control: { max_retries_per_step: 2.5 } },
        { loop_control: { max_retries_per_step: 1e60 } },
        { loop_control: { max_retries_per_step: 0, max_attempts_per_step: null } },
        { models: { 'loop_control.max_steps_per_run': { model: 'literal' } } },
      ];
      let id = 0;
      const expected: unknown[] = [];
      for (const engine of ['kimi', 'codex', 'claude', 'grok']) for (const native of samples) {
        const settings = { native_settings: native, unrelated: { retained: true } };
        expected.push({ ...settings, native_settings: engine === 'kimi' ? migrateStoredKimiNativeSettings(native) : native });
        await db.query(`INSERT INTO ${table} VALUES (?, ?, ?, 'historical body', 'historical digest')`, [++id, engine, JSON.stringify(settings)]);
      }
      const source = (await readFile(new URL('../../src/db/migrations/0134_kimi_native_retirements.sql', import.meta.url), 'utf8')).replaceAll('client_config_documents', table);
      for (let run = 0; run < 2; run++) {
        for (const statement of splitSqlStatements(source)) await db.query(statement);
        const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${table} ORDER BY id`);
        expect(rows).toHaveLength(expected.length);
        rows.forEach((row, index) => {
          expect(typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings).toEqual(expected[index]);
          expect(row).toMatchObject({ body: 'historical body', sha256: 'historical digest' });
        });
      }
    } finally { db.release(); }
  });
});

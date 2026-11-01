import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getTestDb } from '../../helpers/test-db.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { claudeFastModeCases } from '../../fixtures/claude-fast-mode-cases.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Opus 4.8 fast-mode migration (0122)', () => {
  const ids: number[] = [];
  afterAll(async () => {
    if (ids.length) await handle!.pool.query('DELETE FROM client_config_documents WHERE id IN (?)', [ids]);
    await handle?.pool.end();
  });

  it('matches authored env/alias precedence, rejects new combinations and preserves opaque IDs on repeat migration', async () => {
    const caseIds: number[] = [];
    const body = 'historical env selection snapshot';
    const sha256 = createHash('sha256').update(body).digest('hex');
    for (const [, settings] of claudeFastModeCases) {
      const [row] = await handle!.pool.execute<ResultSetHeader>(
        'INSERT INTO client_config_documents (engine,settings,body,sha256,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        ['claude', JSON.stringify(settings), body, sha256, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'],
      );
      caseIds.push(row.insertId); ids.push(row.insertId);
    }
    const service = new ClientConfigService(handle!.db);
    const current = await service.adminFetch('claude');
    expect(current).toMatchObject({ content: body, sha256, settings: { model: 'claude-opus-5-5', native_settings: { fastMode: false } } });
    for (const [, settings, deprecated] of claudeFastModeCases) {
      if (deprecated) await expect(service.store({ settings, expected_revision: current.revision }, null, 'claude')).rejects.toMatchObject({ status: 422 });
    }
    const sql = await readFile(new URL('../../../src/db/migrations/0122_claude_opus48_fast_mode.sql', import.meta.url), 'utf8');
    const connection = await handle!.pool.getConnection();
    try {
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of splitSqlStatements(sql)) await connection.query(statement);
        const [rows] = await connection.query<RowDataPacket[]>('SELECT * FROM client_config_documents WHERE id IN (?) ORDER BY id', [caseIds]);
        for (const [index, row] of rows.entries()) {
          const [, settings, deprecated] = claudeFastModeCases[index]!;
          expect(row).toMatchObject({ body, sha256, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' });
          expect(row.settings).toEqual({ ...settings, native_settings: { ...settings.native_settings, fastMode: !deprecated } });
        }
      }
    } finally { connection.release(); }
  });

  it('repairs only known true combinations idempotently and preserves historical snapshots and other engines', async () => {
    const baseIds: number[] = [];
    const body = '{"model":"claude-opus-4-8","fastMode":true}\n';
    const sha256 = createHash('sha256').update(body).digest('hex');
    const at = '2026-11-01T00:00:00Z';
    const cases = [
      ['claude', 'claude-opus-4-8', true, false],
      ['claude', 'claude-opus-4-8[1m]', true, false],
      ['claude', ' CLAUDE-OPUS-4-8 ', true, false],
      ['claude', 'claude-opus-4-8', false, false],
      ['claude', 'claude-opus-4-8', 'true', 'true'],
      ['claude', 'claude-opus-4-8', 1, 1],
      ['claude', 'claude-opus-5-5', true, true],
      ['claude', 'vendor/claude-opus-4-8', true, true],
      ['claude', 'opus', true, true],
      ['codex', 'claude-opus-4-8', true, true],
      ['grok', 'claude-opus-4-8', true, true],
    ] as const;
    for (const [engine, model, fastMode] of cases) {
      const settings = { model, native_settings: { fastMode, language: 'de', env: { 'fastMode': 'opaque', 'claude-opus-4-8': 'kept' } } };
      const [row] = await handle!.pool.execute<ResultSetHeader>(
        'INSERT INTO client_config_documents (engine,settings,body,sha256,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        [engine, JSON.stringify(settings), body, sha256, at, at],
      );
      ids.push(row.insertId); baseIds.push(row.insertId);
    }
    const sql = await readFile(new URL('../../../src/db/migrations/0122_claude_opus48_fast_mode.sql', import.meta.url), 'utf8');
    const connection = await handle!.pool.getConnection();
    try {
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of splitSqlStatements(sql)) await connection.query(statement);
        const [rows] = await connection.query<RowDataPacket[]>('SELECT * FROM client_config_documents WHERE id IN (?) ORDER BY id', [baseIds]);
        for (const [index, row] of rows.entries()) {
          expect(row).toMatchObject({ body, sha256, created_at: at, updated_at: at });
          expect(row.settings).toEqual({ model: cases[index]![1], native_settings: {
            fastMode: cases[index]![3], language: 'de', env: { fastMode: 'opaque', 'claude-opus-4-8': 'kept' },
          } });
        }
      }
    } finally { connection.release(); }
  });

  it('heals an unmigrated read, rejects raw true, saves correction with CAS and removes mode normally on another model', async () => {
    const settings = { model: 'claude-opus-4-8', native_settings: { fastMode: true, language: 'de' } };
    const body = 'immutable old snapshot';
    const sha256 = createHash('sha256').update(body).digest('hex');
    const [insert] = await handle!.pool.execute<ResultSetHeader>(
      'INSERT INTO client_config_documents (engine,settings,body,sha256,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      ['claude', JSON.stringify(settings), body, sha256, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'],
    );
    ids.push(insert.insertId);
    const service = new ClientConfigService(handle!.db);
    const current = await service.adminFetch('claude');
    expect(current).toMatchObject({ revision: String(insert.insertId), content: body, sha256,
      settings: { model: 'claude-opus-4-8', native_settings: { fastMode: false, language: 'de' } } });
    expect(current.validation_error).toBeUndefined();
    await expect(service.store({ settings, expected_revision: current.revision }, null, 'claude')).rejects.toMatchObject({ status: 422 });
    const saved = await service.store({ settings: current.settings, expected_revision: current.revision, sha256 }, null, 'claude');
    ids.push(Number(saved.revision));
    expect(JSON.parse(saved.content)).toMatchObject({ model: 'claude-opus-4-8', fastMode: false, language: 'de' });
    await expect(service.store({ settings: current.settings, expected_revision: current.revision }, null, 'claude')).rejects.toMatchObject({ status: 409 });
    const next = await service.store({ settings: { ...saved.settings, model: 'claude-opus-5-5', native_settings: { language: 'de' } }, expected_revision: saved.revision }, null, 'claude');
    ids.push(Number(next.revision));
    expect(JSON.parse(next.content)).not.toHaveProperty('fastMode');
    const [rows] = await handle!.pool.query<RowDataPacket[]>('SELECT settings,body,sha256 FROM client_config_documents WHERE id=?', [insert.insertId]);
    expect(rows[0]).toMatchObject({ settings, body, sha256 });
  });
});

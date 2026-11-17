import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { ClientConfigService } from '../../src/services/client-config.js';
import { getTestDb } from '../helpers/test-db.js';

const handle = await getTestDb();
const table = 'codex_0169_retirement_test_documents';

describe.skipIf(!handle)('Codex 0.169 retired controls migration', () => {
  afterAll(async () => {
    if (!handle) return;
    await handle.pool.query(`DROP TABLE IF EXISTS ${table}`);
    await handle.pool.end();
  });
  it('heals every exact root/profile path twice, keeping siblings, literal names, other engines and history', async () => {
    const db = await handle!.pool.getConnection();
    const features = { multi_agent: false, plugin_discovery_prefetch: true, hooks: false, multi_agent_v2: { enabled: false } };
    const native = { features: structuredClone(features), auto_review: { experimental_policy_template: 'old template', extra_policy: 'old policy', timeout_ms: 1 },
      mcp_servers: { 'features.multi_agent': { command: '/bin/echo' } },
      plugins: { 'auto_review.extra_policy@test': { enabled: false } } };
    const legacy = { features, native_settings: native, profiles: [
      { name: 'first', features: structuredClone(features), native_settings: structuredClone(native) },
      { name: 'second', features: { multi_agent: true, plugin_discovery_prefetch: false } },
      { name: 'untouched', native_settings: { notify: ['/bin/echo'] } },
    ] };
    const expected = structuredClone(legacy);
    const strip = (value: unknown) => {
      const record = value as { features?: Record<string, unknown>; auto_review?: Record<string, unknown>; native_settings?: Record<string, unknown>; agents?: Record<string, unknown> } | undefined;
      if (record) {
        const native = (record.native_settings ?? record) as Record<string, unknown>;
        const nativeFeatures = native.features as Record<string, unknown> | undefined;
        const legacyFlag = record.features?.multi_agent ?? nativeFeatures?.multi_agent;
        if (legacyFlag === false && !Object.hasOwn((native.agents as Record<string, unknown> | undefined) ?? {}, 'enabled')) native.agents = { ...(native.agents as Record<string, unknown> | undefined), enabled: false };
      }
      if (record?.features) { delete record.features.multi_agent; delete record.features.plugin_discovery_prefetch; }
      if (record?.auto_review) { delete record.auto_review.experimental_policy_template; delete record.auto_review.extra_policy; }
    };
    strip(expected); strip(expected.native_settings);
    for (const profile of expected.profiles) { strip(profile); strip(profile.native_settings); }
    const body = 'historical authored TOML\nmulti_agent = true';
    const sha = createHash('sha256').update(body).digest('hex');
    try {
      await db.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, engine VARCHAR(20), settings JSON, body TEXT, sha256 VARCHAR(64), updated_at VARCHAR(30))`);
      const fixtures = [['codex', legacy], ['claude', legacy], ['grok', legacy], ['kimi', legacy], ['codex', { profiles: 'opaque' }], ['codex', null],
        ['codex', { features: { multi_agent: true }, native_settings: { features: { multi_agent: false } } }],
        ['codex', { features: { multi_agent: false }, native_settings: { features: { multi_agent: true } } }],
        ['codex', { native_settings: { features: { multi_agent: false }, agents: { enabled: true } } }],
        ['codex', { features: { multi_agent: false } }],
        ['codex', { features: { multi_agent: false }, native_settings: null }],
      ] as const;
      for (const [index, [engine, settings]] of fixtures.entries()) {
        await db.query(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?)`, [index, engine, settings === null ? null : JSON.stringify(settings), body, sha, '2026-11-01T00:00:00Z']);
      }
      const migration = (await readFile(new URL('../../src/db/migrations/0132_codex_169_retired_controls.sql', import.meta.url), 'utf8')).replaceAll('client_config_documents', table);
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of splitSqlStatements(migration)) await db.query(statement);
        const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${table} ORDER BY id`);
        const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;
        expect(json(rows[0]!.settings)).toEqual(expected);
        for (const i of [1, 2, 3]) expect(json(rows[i]!.settings)).toEqual(legacy);
        expect(json(rows[4]!.settings)).toEqual({ profiles: 'opaque' });
        expect(rows[5]!.settings).toBeNull();
        expect(json(rows[6]!.settings)).toEqual({ features: {}, native_settings: { features: {} } });
        expect(json(rows[7]!.settings)).toEqual({ features: {}, native_settings: { features: {}, agents: { enabled: false } } });
        expect(json(rows[8]!.settings)).toEqual({ native_settings: { features: {}, agents: { enabled: true } } });
        expect(json(rows[9]!.settings)).toEqual({ features: {}, native_settings: { agents: { enabled: false } } });
        expect(json(rows[10]!.settings)).toEqual({ features: {}, native_settings: { agents: { enabled: false } } });
        for (const row of rows) expect(row).toMatchObject({ body, sha256: sha, updated_at: '2026-11-01T00:00:00Z' });
        const rendered = new ClientConfigService({} as never).render(json(rows[0]!.settings));
        for (const content of [rendered.content, ...rendered.profiles!.map(profile => profile.content)]) {
          expect(content).not.toMatch(/^(multi_agent|plugin_discovery_prefetch|experimental_policy_template|extra_policy) =/m);
        }
        expect(rendered.content).toContain('[mcp_servers."features.multi_agent"]');
        expect(rendered.profiles?.map(profile => profile.name)).toEqual(['first', 'second', 'untouched']);
        expect(rendered.content).toContain('timeout_ms = 1');
      }
    } finally { db.release(); }
  });
});

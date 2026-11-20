/**
 * `/admin/{openai,claude,grok,kimi}/keys` are one admin surface over the
 * `openai_api_keys` table, told apart only by `engine`, and the admin UI drives
 * all four through one client (`frontend/src/lib/api/keys.ts`). They used to be
 * four implementations that disagreed (2026-11-20, API-AUTH-04): OpenAI coerced
 * any toggle body to a boolean (`{}` meant "disable") and took any
 * `expires_at` string, Claude answered a toggle with no id and audited
 * `enable`/`disable`, Grok and Kimi answered 422 and omitted `admin_user_id`.
 * Every case here runs against all four registrations.
 *
 * Every store holds rows of the other engines too, so a dropped engine filter
 * has to fail a test rather than leak across surfaces.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { logs, openaiApiKeys } from '../../../src/db/schema.js';
import { registerAdminClaudeKeyRoutes } from '../../../src/routes/admin/keys/claude.js';
import { registerAdminOpenAiKeyRoutes } from '../../../src/routes/admin/keys/openai.js';
import { registerAdminGrokRoutes } from '../../../src/routes/admin/grok/index.js';
import { registerAdminKimiRoutes } from '../../../src/routes/admin/kimi/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';

type Row = Record<string, unknown>;

const SURFACES = [
  { surface: 'openai', engine: 'codex', prefix: 'sk-cdx-' },
  { surface: 'claude', engine: 'claude', prefix: 'sk-ant-' },
  { surface: 'grok', engine: 'grok', prefix: 'sk-cgx-' },
  { surface: 'kimi', engine: 'kimi', prefix: 'sk-ckx-' },
] as const;

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

const openApps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function buildApp(seed: Row[] = []) {
  const app = await buildRouteApp();
  openApps.push(app);
  const db = withOrderBy(createDbFake());
  db.tables.set(openaiApiKeys, seed);
  const ctx = { db, keyring: testKeyring(), env: {} } as unknown as RouteContext;
  await registerAdminOpenAiKeyRoutes(app, ctx);
  await registerAdminClaudeKeyRoutes(app, ctx);
  await registerAdminGrokRoutes(app, ctx);
  await registerAdminKimiRoutes(app, ctx);
  return { app, db };
}

function keyRow(overrides: Row): Row {
  return {
    name: 'seeded',
    keyPrefix: 'sk-xxx-000000000...',
    keyHash: sha256Hex(`seed-${String(overrides.id)}`),
    keyEnc: null,
    adminUserId: null,
    isActive: 1,
    useCount: 0,
    lastUsedAt: null,
    expiresAt: null,
    backendEngine: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

describe.each(SURFACES)('/admin/$surface/keys', ({ surface, engine, prefix }) => {
  const base = `/admin/${surface}/keys`;

  it.each([
    ['POST', base, {}, 'name'],
    ['POST', base, { name: '   ' }, 'name'],
    ['POST', base, { name: 'x'.repeat(256) }, 'name'],
    ['POST', base, { name: 'k', expires_at: 'tomorrow' }, 'expires_at'],
    ['POST', base, { name: 'k', expires_at: '2026-13-01T00:00:00Z' }, 'expires_at'],
    ['POST', base, { name: 'k', expires_at: 1767225600 }, 'expires_at'],
    ['POST', base, ['k'], undefined],
    ['POST', `${base}/1/toggle`, {}, 'active'],
    ['POST', `${base}/1/toggle`, { active: 'maybe' }, 'active'],
    ['POST', `${base}/1x/toggle`, { active: true }, 'id'],
    ['POST', `${base}/0/toggle`, { active: true }, 'id'],
    ['DELETE', `${base}/abc`, undefined, 'id'],
    ['DELETE', `${base}/1.5`, undefined, 'id'],
  ] as const)('answers %s %s %j with 400 invalid_request', async (method, url, payload, param) => {
    const seeded = keyRow({ id: 1, engine });
    const { app, db } = await buildApp([seeded]);
    const reply = await app.inject({ method, url, payload: payload as never });
    expect(reply.statusCode).toBe(400);
    const body = reply.json();
    expect(body).toMatchObject({ code: 'invalid_request' });
    // The standard admin envelope carries no `param`; the message names it.
    expect(body.message).toContain(param ?? 'JSON object');
    expect(db.tables.get(openaiApiKeys)).toEqual([seeded]);
  });

  it('issues, lists, toggles and deletes a key with the shared record and responses', async () => {
    const { app, db } = await buildApp([keyRow({ id: 90, engine: engine === 'codex' ? 'claude' : 'codex' })]);

    const created = await app.inject({
      method: 'POST',
      url: base,
      payload: { name: '  release  ', expires_at: ' 2027-01-01T00:00:00Z ' },
    });
    expect(created.statusCode).toBe(200);
    const { key, record } = created.json().data as { key: string; record: Row & { id: number } };
    expect(key.startsWith(prefix)).toBe(true);
    expect(key).toHaveLength(prefix.length + 64);
    expect(record).toEqual({
      id: expect.any(Number),
      name: 'release',
      key_prefix: `${key.slice(0, 16)}...`,
      admin_user_id: null,
      is_active: true,
      use_count: 0,
      last_used_at: null,
      expires_at: '2027-01-01T00:00:00Z',
      engine,
      backend_engine: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    const stored = db.tables.get(openaiApiKeys)!.find((row) => row.id === record.id)!;
    expect(stored).toMatchObject({ engine, keyHash: sha256Hex(key), keyEnc: expect.any(String) });
    expect(stored.keyEnc).not.toContain(key);

    expect((await app.inject(base)).json().data).toEqual([record]);

    const toggled = await app.inject({ method: 'POST', url: `${base}/${record.id}/toggle`, payload: { active: false } });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json().data).toEqual({ id: record.id, active: false, message: 'Key disabled' });
    expect((await app.inject(base)).json().data[0].is_active).toBe(false);

    const removed = await app.inject({ method: 'DELETE', url: `${base}/${record.id}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toEqual({ id: record.id, message: 'Key deleted' });
    expect((await app.inject(base)).json().data).toEqual([]);

    expect((db.tables.get(logs) ?? []).map((row) => [row.action, row.engine])).toEqual([
      [`${surface}.key.create`, engine],
      [`${surface}.key.toggle`, engine],
      [`${surface}.key.delete`, engine],
    ]);
  });

  it('treats a blank or null expires_at as never expiring', async () => {
    const { app } = await buildApp();
    for (const expires_at of ['', '  ', null]) {
      const reply = await app.inject({ method: 'POST', url: base, payload: { name: 'n', expires_at } });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().data.record.expires_at).toBeNull();
    }
  });

  it('lists, toggles and deletes only keys of its own namespace', async () => {
    // Out of createdAt order so the list has to sort; `openai` is a stray
    // spelling the column (free-form varchar) can hold and no surface owns.
    const seed = [
      keyRow({ id: 1, name: 'own-old', engine, createdAt: '2026-07-01T00:00:00Z' }),
      keyRow({ id: 2, name: 'other', engine: engine === 'codex' ? 'claude' : 'codex', createdAt: '2026-07-02T00:00:00Z' }),
      keyRow({ id: 3, name: 'own-new', engine, createdAt: '2026-07-03T00:00:00Z' }),
      keyRow({ id: 4, name: 'stray', engine: 'openai', createdAt: '2026-07-04T00:00:00Z' }),
      keyRow({ id: 5, name: 'own-mid', engine, createdAt: '2026-07-02T12:00:00Z' }),
    ];
    const { app, db } = await buildApp(structuredClone(seed));

    expect((await app.inject(base)).json().data.map((row: Row) => row.name)).toEqual(['own-new', 'own-mid', 'own-old']);
    for (const id of [2, 4]) {
      expect((await app.inject({ method: 'POST', url: `${base}/${id}/toggle`, payload: { active: false } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `${base}/${id}` })).statusCode).toBe(404);
    }
    expect(db.updates).toHaveLength(0);
    expect(db.deletes).toHaveLength(0);
    expect(db.tables.get(openaiApiKeys)).toEqual(seed);
  });
});

/**
 * `createDbFake` ignores `.orderBy(...)`; apply the `desc(column)` it carries
 * so dropping or flipping the list ORDER BY actually fails.
 */
function withOrderBy(db: DbFake): DbFake {
  type Ordered = { orderBy(...args: unknown[]): Promise<Row[]> };
  type Filtered = { where(condition: unknown): Ordered };
  const baseSelect = db.select.bind(db);
  db.select = (fields?: unknown) => {
    const chain = baseSelect(fields) as { from(table: unknown): Filtered };
    return {
      from(table: unknown) {
        const builder = chain.from(table);
        const baseWhere = builder.where.bind(builder);
        builder.where = (condition: unknown) => {
          const filtered = baseWhere(condition);
          const baseOrderBy = filtered.orderBy.bind(filtered);
          filtered.orderBy = async (...args: unknown[]) => sortRows(await baseOrderBy(...args), args[0]);
          return filtered;
        };
        return builder;
      },
    };
  };
  return db;
}

function sortRows(rows: Row[], order: unknown): Row[] {
  const chunks = (order as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return rows;
  const column = chunks.find(
    (chunk): chunk is { name: string } => !!chunk && typeof chunk === 'object' && 'table' in chunk && 'name' in chunk,
  );
  if (!column) return rows;
  const descending = /\bdesc\b/i.test(chunks.map(chunkText).join(''));
  const camel = column.name.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase());
  return rows.slice().sort((a, b) => {
    const left = String(a[camel] ?? '');
    const right = String(b[camel] ?? '');
    return descending ? right.localeCompare(left) : left.localeCompare(right);
  });
}

function chunkText(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object' || chunk.constructor?.name !== 'StringChunk') return '';
  const raw = (chunk as { value?: unknown }).value;
  return Array.isArray(raw) ? raw.join('') : typeof raw === 'string' ? raw : '';
}

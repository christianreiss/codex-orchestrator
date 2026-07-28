/**
 * The Claude and OpenAI key services share the single `openai_api_keys` table
 * and are told apart only by the `engine` column, so every read and mutation
 * here is checked against a store that also holds non-claude rows: a dropped
 * `eq(engine, 'claude')` has to fail a test, not leak across engines.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { openaiApiKeys } from '../../../src/db/schema.js';
import {
  createClaudeKeysService,
  CLAUDE_KEY_PREFIX,
} from '../../../src/services/claude-keys.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { ApiError } from '../../../src/http/errors.js';
import type { Database } from '../../../src/db/client.js';

type Row = Record<string, unknown>;

const keyring = testKeyring();
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

function keyRow(overrides: Row): Row {
  return {
    name: 'seeded',
    keyPrefix: 'sk-ant-000000000...',
    keyHash: sha256Hex(`seed-${String(overrides.id)}`),
    keyEnc: null,
    adminUserId: null,
    rateLimitRpm: 60,
    isActive: 1,
    useCount: 0,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    engine: 'claude',
    ...overrides,
  };
}

/**
 * Seeded deliberately out of createdAt order so `list()` has to sort, and with
 * both non-claude spellings: the OpenAI service writes `engine = 'codex'`, but
 * the column is a free-form varchar, so 'openai' has to stay invisible too.
 */
function seededDb(): DbFake {
  const db = withOrderBy(createDbFake());
  db.tables.set(openaiApiKeys, [
    keyRow({ id: 1, name: 'claude-old', createdAt: '2026-07-01T00:00:00Z' }),
    keyRow({ id: 2, name: 'openai-key', engine: 'codex', createdAt: '2026-07-02T00:00:00Z' }),
    keyRow({ id: 3, name: 'claude-new', createdAt: '2026-07-03T00:00:00Z' }),
    keyRow({ id: 4, name: 'openai-alias', engine: 'openai', createdAt: '2026-07-04T00:00:00Z' }),
    keyRow({ id: 5, name: 'claude-mid', createdAt: '2026-07-02T12:00:00Z' }),
  ]);
  return db;
}

function service(db: DbFake) {
  return createClaudeKeysService(db as unknown as Database, keyring);
}

function storedRow(db: DbFake, id: number): Row {
  return db.tables.get(openaiApiKeys)!.find((row) => row.id === id)!;
}

describe('createClaudeKeysService engine scoping', () => {
  it('lists only claude rows, newest first', async () => {
    const rows = await service(seededDb()).list();
    expect(rows.map((r) => r.name)).toEqual(['claude-new', 'claude-mid', 'claude-old']);
    expect(rows.every((r) => r.engine === 'claude')).toBe(true);
  });

  it('does not find rows belonging to another engine', async () => {
    const svc = service(seededDb());
    expect(await svc.findById(2)).toBeNull();
    expect(await svc.findById(4)).toBeNull();
    expect(await svc.findById(3)).toMatchObject({ id: 3, name: 'claude-new' });
  });

  it('refuses to deactivate another engine key and leaves the row untouched', async () => {
    const db = seededDb();
    expect(await service(db).setActive(2, false)).toBeNull();
    expect(storedRow(db, 2)).toMatchObject({ isActive: 1, engine: 'codex' });
    expect(db.updates).toHaveLength(0);
  });

  it('deactivates a claude key', async () => {
    const db = seededDb();
    const updated = await service(db).setActive(3, false);
    expect(updated).toMatchObject({ id: 3, is_active: false });
    expect(storedRow(db, 3).isActive).toBe(0);
    // The sibling engine rows are untouched by the scoped UPDATE.
    expect(storedRow(db, 2).isActive).toBe(1);
    expect(storedRow(db, 4).isActive).toBe(1);
  });

  it('refuses to delete another engine key and leaves the row in the store', async () => {
    const db = seededDb();
    expect(await service(db).delete(4)).toBe(false);
    expect(storedRow(db, 4)).toMatchObject({ name: 'openai-alias', engine: 'openai' });
    expect(db.deletes).toHaveLength(0);
  });

  it('deletes a claude key', async () => {
    const db = seededDb();
    expect(await service(db).delete(1)).toBe(true);
    expect(db.tables.get(openaiApiKeys)!.map((r) => r.id)).toEqual([2, 3, 4, 5]);
  });
});

describe('createClaudeKeysService.create', () => {
  it('issues an sk-ant- key stored as a sha256 hash with a 16-char display prefix', async () => {
    const db = seededDb();
    const { key, record } = await service(db).create({ name: '  release  ' });

    expect(key.startsWith(CLAUDE_KEY_PREFIX)).toBe(true);
    expect(key.length).toBe(CLAUDE_KEY_PREFIX.length + 64);

    const row = db.tables.get(openaiApiKeys)!.find((r) => r.name === 'release')!;
    expect(row.keyHash).toBe(sha256Hex(key));
    expect(row.keyHash).not.toBe(key);
    expect(row.engine).toBe('claude');
    expect(row.keyEnc).toEqual(expect.any(String));

    expect(record.key_prefix).toBe(`${key.slice(0, 16)}...`);
    expect(record.key_prefix).toHaveLength(19);
    expect(record.name).toBe('release');
    expect(record.is_active).toBe(true);
    expect(record.engine).toBe('claude');
  });

  it('honours an explicit prefix', async () => {
    const { key, record } = await service(seededDb()).create({
      name: 'custom',
      prefix: 'sk-ant-admin-',
    });
    expect(key.startsWith('sk-ant-admin-')).toBe(true);
    expect(record.key_prefix).toBe(`${key.slice(0, 16)}...`);
  });

  it('defaults rate_limit_rpm to 60 for missing, zero and negative values', async () => {
    const svc = service(seededDb());
    expect((await svc.create({ name: 'a' })).record.rate_limit_rpm).toBe(60);
    expect((await svc.create({ name: 'b', rateLimitRpm: 0 })).record.rate_limit_rpm).toBe(60);
    expect((await svc.create({ name: 'c', rateLimitRpm: -5 })).record.rate_limit_rpm).toBe(60);
  });

  it('floors a fractional rate limit', async () => {
    const { record } = await service(seededDb()).create({ name: 'd', rateLimitRpm: 12.9 });
    expect(record.rate_limit_rpm).toBe(12);
  });

  it('rejects a blank name', async () => {
    const svc = service(seededDb());
    await expect(svc.create({ name: '' })).rejects.toThrow('name is required');
    await expect(svc.create({ name: '   ' })).rejects.toThrow('name is required');
  });

  it('rejects a non-RFC3339 expiresAt with invalid_expires_at', async () => {
    const svc = service(seededDb());
    await expect(svc.create({ name: 'e', expiresAt: '2026-13-01' })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(svc.create({ name: 'e', expiresAt: 'tomorrow' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_expires_at',
      type: 'invalid_request_error',
      param: 'expires_at',
    });
  });

  it('treats an empty expiresAt as null and keeps a valid one', async () => {
    const svc = service(seededDb());
    expect((await svc.create({ name: 'f', expiresAt: '' })).record.expires_at).toBeNull();
    expect((await svc.create({ name: 'g', expiresAt: '  ' })).record.expires_at).toBeNull();
    expect((await svc.create({ name: 'h', expiresAt: undefined })).record.expires_at).toBeNull();
    expect(
      (await svc.create({ name: 'i', expiresAt: ' 2027-01-01T00:00:00Z ' })).record.expires_at,
    ).toBe('2027-01-01T00:00:00Z');
  });
});

/**
 * `createDbFake` returns rows in insertion order and ignores `.orderBy(...)`,
 * which would make the list-ordering assertion a restatement of the seed order.
 * This applies the ordering carried by the drizzle `desc(column)` SQL object so
 * dropping or flipping the ORDER BY actually fails.
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
          filtered.orderBy = async (...args: unknown[]) =>
            sortRows(await baseOrderBy(...args), args[0]);
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
    (chunk): chunk is { name: string } =>
      !!chunk && typeof chunk === 'object' && 'table' in chunk && 'name' in chunk,
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

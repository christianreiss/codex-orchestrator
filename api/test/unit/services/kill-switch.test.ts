/**
 * Direct coverage for the two proxy kill switches. Every route-level test
 * injects a hand-written stub, so the real flag parsing, the deliberate
 * fail-open on a broken `versions` read and the Claude-side TTL cache are only
 * exercised here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeOpenAiKillSwitch } from '../../../src/services/openai-kill-switch.js';
import { createClaudeKillSwitch } from '../../../src/services/claude-kill-switch.js';
import { ApiError } from '../../../src/http/errors.js';
import type { Database } from '../../../src/db/client.js';

const OPENAI_FLAG = 'openai_api_disabled';
const CLAUDE_FLAG = 'claude_api_disabled';

interface VersionRow {
  name: string;
  version: string | null;
  updatedAt?: string;
}

type Fields = Record<string, { name: string }>;

interface VersionsDb {
  db: Database;
  rows: VersionRow[];
  /** Number of `versions` reads issued — pins the Claude TTL cache. */
  selects: number;
  /** When set, every read rejects so the fail-open branch runs. */
  rejectSelects: boolean;
  inserts: VersionRow[];
  updates: Array<{ name: string | undefined; set: Record<string, unknown> }>;
}

/**
 * In-memory `versions` table covering just the drizzle chain both switches
 * use: projected (`select({ value: versions.version })`) and unprojected
 * selects filtered by flag name, plus insert/update recording.
 */
function createVersionsDb(rows: VersionRow[] = []): VersionsDb {
  const read = async (fields: Fields | undefined, where: unknown) => {
    stub.selects += 1;
    if (stub.rejectSelects) throw new Error('versions table unreachable');
    const name = whereName(where);
    return stub.rows.filter((row) => row.name === name).map((row) => project(row, fields));
  };

  const db = {
    select(fields?: Fields) {
      return {
        from: (_table: unknown) => ({
          where: (condition: unknown) => ({
            limit: (_n: number) => read(fields, condition),
          }),
        }),
      };
    },
    insert(_table: unknown) {
      return {
        values: async (values: VersionRow) => {
          stub.inserts.push(values);
          stub.rows.push(values);
        },
      };
    },
    update(_table: unknown) {
      return {
        set: (values: Record<string, unknown>) => ({
          where: async (condition: unknown) => {
            const name = whereName(condition);
            stub.updates.push({ name, set: values });
            for (const row of stub.rows.filter((r) => r.name === name)) Object.assign(row, values);
          },
        }),
      };
    },
  };

  const stub: VersionsDb = {
    db: db as unknown as Database,
    rows,
    selects: 0,
    rejectSelects: false,
    inserts: [],
    updates: [],
  };
  return stub;
}

/** Pulls the bound value out of an `eq(versions.name, FLAG)` condition. */
function whereName(condition: unknown): string | undefined {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? [];
  const param = chunks.find(
    (chunk): chunk is { value: unknown } =>
      !!chunk && typeof chunk === 'object' && chunk.constructor?.name === 'Param',
  );
  return typeof param?.value === 'string' ? param.value : undefined;
}

function project(row: VersionRow, fields: Fields | undefined): Record<string, unknown> {
  if (!fields) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [alias, column] of Object.entries(fields)) {
    out[alias] = (row as unknown as Record<string, unknown>)[column.name];
  }
  return out;
}

function flagRow(name: string, version: string | null): VersionRow {
  return { name, version, updatedAt: '2026-07-28T00:00:00.000Z' };
}

/** The two switches share the read path; only the guard method name differs. */
interface Subject {
  isDisabled(): Promise<boolean>;
  guard(): Promise<void>;
}

const implementations = [
  {
    label: 'makeOpenAiKillSwitch',
    flag: OPENAI_FLAG,
    make: (db: Database): Subject => {
      const killSwitch = makeOpenAiKillSwitch(db);
      return { isDisabled: () => killSwitch.isDisabled(), guard: () => killSwitch.throwIfDisabled() };
    },
  },
  {
    label: 'createClaudeKillSwitch',
    flag: CLAUDE_FLAG,
    make: (db: Database): Subject => {
      const killSwitch = createClaudeKillSwitch(db);
      return { isDisabled: () => killSwitch.isDisabled(), guard: () => killSwitch.ensureEnabled() };
    },
  },
];

const TRUTHY = ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ', '  TRUE\t', '\nYes\n'];
const FALSY = ['false', '0', 'off', 'FALSE', '', '   ', 'maybe', 'enabled'];

describe.each(implementations)('$label', ({ flag, make }) => {
  it.each(TRUTHY)('treats %j as disabled', async (value) => {
    const stub = createVersionsDb([flagRow(flag, value)]);
    await expect(make(stub.db).isDisabled()).resolves.toBe(true);
  });

  it.each(FALSY)('treats %j as enabled', async (value) => {
    const stub = createVersionsDb([flagRow(flag, value)]);
    await expect(make(stub.db).isDisabled()).resolves.toBe(false);
  });

  it('stays enabled when the flag row is missing', async () => {
    const stub = createVersionsDb([]);
    await expect(make(stub.db).isDisabled()).resolves.toBe(false);
  });

  it('stays enabled when the row value is null', async () => {
    const stub = createVersionsDb([flagRow(flag, null)]);
    await expect(make(stub.db).isDisabled()).resolves.toBe(false);
  });

  it('ignores the other proxy’s flag row', async () => {
    const other = flag === OPENAI_FLAG ? CLAUDE_FLAG : OPENAI_FLAG;
    const stub = createVersionsDb([flagRow(other, 'true')]);
    await expect(make(stub.db).isDisabled()).resolves.toBe(false);
  });

  it('fails open when the versions read rejects', async () => {
    const stub = createVersionsDb([flagRow(flag, 'true')]);
    stub.rejectSelects = true;
    const subject = make(stub.db);
    await expect(subject.isDisabled()).resolves.toBe(false);
    await expect(subject.guard()).resolves.toBeUndefined();
    expect(stub.selects).toBeGreaterThan(0);
  });

  it('guards with a 503 api_disabled ApiError when set', async () => {
    const stub = createVersionsDb([flagRow(flag, 'true')]);
    const error = await make(stub.db)
      .guard()
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(503);
    expect(apiError.code).toBe('api_disabled');
    expect(apiError.type).toBe('api_error');
  });

  it('guards without throwing when the flag is off', async () => {
    const stub = createVersionsDb([flagRow(flag, 'false')]);
    await expect(make(stub.db).guard()).resolves.toBeUndefined();
  });
});

describe('makeOpenAiKillSwitch', () => {
  it('re-reads the flag on every call', async () => {
    const row = flagRow(OPENAI_FLAG, 'false');
    const stub = createVersionsDb([row]);
    const killSwitch = makeOpenAiKillSwitch(stub.db);

    await expect(killSwitch.isDisabled()).resolves.toBe(false);
    row.version = 'on';
    await expect(killSwitch.isDisabled()).resolves.toBe(true);
    expect(stub.selects).toBe(2);
  });
});

describe('createClaudeKillSwitch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a second read from the 1s TTL cache', async () => {
    const row = flagRow(CLAUDE_FLAG, 'true');
    const stub = createVersionsDb([row]);
    const killSwitch = createClaudeKillSwitch(stub.db);

    await expect(killSwitch.isDisabled()).resolves.toBe(true);
    row.version = 'false';
    await expect(killSwitch.isDisabled()).resolves.toBe(true);
    expect(stub.selects).toBe(1);
  });

  it('re-reads once the TTL window has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    const row = flagRow(CLAUDE_FLAG, 'true');
    const stub = createVersionsDb([row]);
    const killSwitch = createClaudeKillSwitch(stub.db);

    await expect(killSwitch.isDisabled()).resolves.toBe(true);
    row.version = 'false';
    vi.setSystemTime(new Date('2026-07-28T00:00:01.001Z'));
    await expect(killSwitch.isDisabled()).resolves.toBe(false);
    expect(stub.selects).toBe(2);
  });

  it('updates the existing row via setDisabled', async () => {
    const row = flagRow(CLAUDE_FLAG, 'false');
    const stub = createVersionsDb([row]);
    const killSwitch = createClaudeKillSwitch(stub.db);

    await killSwitch.setDisabled(true);

    const [update] = stub.updates;
    expect(stub.inserts).toEqual([]);
    expect(stub.updates).toHaveLength(1);
    expect(update?.name).toBe(CLAUDE_FLAG);
    expect(update?.set.version).toBe('true');
    expect(update?.set.updatedAt).toEqual(expect.any(String));
    expect(row.version).toBe('true');

    await killSwitch.setDisabled(false);
    expect(row.version).toBe('false');
  });

  it('inserts the flag row via setDisabled when it is missing', async () => {
    const stub = createVersionsDb([]);
    const killSwitch = createClaudeKillSwitch(stub.db);

    await killSwitch.setDisabled(true);

    const [inserted] = stub.inserts;
    expect(stub.updates).toEqual([]);
    expect(stub.inserts).toHaveLength(1);
    expect(inserted).toMatchObject({ name: CLAUDE_FLAG, version: 'true' });
    expect(inserted?.updatedAt).toEqual(expect.any(String));
  });

  it('clears the cache so the next read hits the DB', async () => {
    const stub = createVersionsDb([flagRow(CLAUDE_FLAG, 'false')]);
    const killSwitch = createClaudeKillSwitch(stub.db);

    await expect(killSwitch.isDisabled()).resolves.toBe(false);
    await killSwitch.setDisabled(true);
    const selectsAfterWrite = stub.selects;

    await expect(killSwitch.isDisabled()).resolves.toBe(true);
    expect(stub.selects).toBe(selectsAfterWrite + 1);
  });
});

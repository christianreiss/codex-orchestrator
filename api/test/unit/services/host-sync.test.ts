import { describe, expect, it } from 'vitest';
import { hostUsers, type Host } from '../../../src/db/schema.js';
import { createHostSyncService, type HostSyncService } from '../../../src/services/host-sync.js';
import type { VersionSnapshot, VersionSnapshotService } from '../../../src/services/version-snapshot.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../../../src/util/engine.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

/**
 * The service only reads/writes `host_users`, so the db fake is enough: it
 * filters selects by `eq(hostUsers.hostId, ...)` and records inserts. The
 * wrapper below also records every `.from(table)` so `collect` can be pinned
 * to zero reads -- its callers already hold the users from `recordHostUser`.
 */

const HOST_ID = 7;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// Deliberately unrelated to the rows seeded into the db fake: if `collect`
// ever reads `host_users` again, the returned payload stops matching this.
const SUPPLIED_USERS = [
  { username: 'alice', hostname: 'alice-box', last_seen: '2026-01-02T00:00:00Z' },
  { username: 'bob', hostname: null, last_seen: '2026-01-03T00:00:00Z' },
];

// Returned by the stub as-is, so `versions` must come out identical.
const SNAPSHOT: VersionSnapshot = {
  client_version: '0.42.0',
  client_version_override: null,
  client_version_enforce_exact: false,
  client_version_fetched_at: null,
  wrapper_version: '1.2.3',
  wrapper_sha256: null,
  wrapper_url: null,
  runner_state: 'ready',
  api_disabled: false,
  auto_update_enabled: true,
  cdx_silent: false,
  clx_silent: false,
  agent_messaging_enabled: false,
  installation_id: 'inst-42',
  engine: ENGINE_CODEX,
};

interface VersionsStub extends VersionSnapshotService {
  calls: Array<Engine | undefined>;
}

function makeVersions(): VersionsStub {
  const calls: Array<Engine | undefined> = [];
  return {
    calls,
    summary: async (engine?: Engine) => {
      calls.push(engine);
      return SNAPSHOT;
    },
    flag: async () => false,
    setting: async () => null,
  };
}

function makeHost(overrides: Record<string, unknown> = {}): Host {
  return {
    id: HOST_ID,
    fqdn: 'host.example',
    apiCalls: 0,
    ...overrides,
  } as unknown as Host;
}

function userRow(id: number, hostId: number, username: string, hostname: string | null): Record<string, unknown> {
  return {
    id,
    hostId,
    username,
    hostname,
    firstSeen: '2026-01-01T00:00:00Z',
    lastSeen: '2026-01-02T00:00:00Z',
  };
}

function makeService(db: DbFake, versions: VersionsStub): HostSyncService {
  return createHostSyncService({ db: db as never, versions });
}

interface RecordingDb extends DbFake {
  // Every table handed to `db.select().from(...)`, in call order.
  selects: unknown[];
}

function makeDb(rows: Record<string, unknown>[] = []): RecordingDb {
  const fake = createDbFake();
  fake.tables.set(hostUsers, rows);
  const selects: unknown[] = [];
  const select = fake.select.bind(fake);
  return Object.assign(fake, {
    selects,
    select(fields?: unknown) {
      const builder = select(fields) as { from(table: unknown): unknown };
      return {
        from(table: unknown) {
          selects.push(table);
          return builder.from(table);
        },
      };
    },
  });
}

function hostUserSelects(db: RecordingDb): unknown[] {
  return db.selects.filter((table) => table === hostUsers);
}

function hostUserInserts(db: DbFake): Array<Record<string, unknown>> {
  return db.inserts
    .filter((entry) => entry.table === hostUsers && !Array.isArray(entry.values))
    .map((entry) => entry.values as Record<string, unknown>);
}

describe('HostSyncService.collect', () => {
  it('returns an ok payload with the stub snapshot, the engine and the bootstrap flag verbatim', async () => {
    const versions = makeVersions();
    const service = makeService(makeDb(), versions);

    const out = await service.collect({
      host: makeHost(),
      engine: ENGINE_CLAUDE,
      bootstrap: true,
      users: [],
    });

    expect(out.status).toBe('ok');
    expect(out.reasons).toEqual([]);
    expect(out.engine).toBe(ENGINE_CLAUDE);
    expect(out.versions).toBe(SNAPSHOT);
    expect(out.bootstrap).toBe(true);
    expect(out.host_users).toEqual([]);
    expect(versions.calls).toEqual([ENGINE_CLAUDE]);
  });

  it('passes bootstrap: false through unchanged', async () => {
    const service = makeService(makeDb(), makeVersions());

    const out = await service.collect({
      host: makeHost(),
      engine: ENGINE_CODEX,
      bootstrap: false,
      users: [],
    });

    expect(out.bootstrap).toBe(false);
    expect(out.engine).toBe(ENGINE_CODEX);
  });

  const apiCallCases: Array<{ label: string; apiCalls: unknown; expected: number }> = [
    { label: 'a number', apiCalls: 42, expected: 42 },
    { label: 'a numeric string', apiCalls: '17', expected: 17 },
    { label: 'null', apiCalls: null, expected: 0 },
    { label: 'undefined', apiCalls: undefined, expected: 0 },
  ];

  it.each(apiCallCases)('coerces api_calls from $label', async ({ apiCalls, expected }) => {
    const service = makeService(makeDb(), makeVersions());

    const out = await service.collect({
      host: makeHost({ apiCalls }),
      engine: ENGINE_CODEX,
      bootstrap: false,
      users: [],
    });

    expect(out.api_calls).toBe(expected);
    expect(typeof out.api_calls).toBe('number');
  });

  it('reports the supplied users without reading host_users', async () => {
    const versions = makeVersions();
    const db = makeDb([userRow(1, HOST_ID, 'mallory', 'other-box')]);

    const out = await makeService(db, versions).collect({
      host: makeHost({ apiCalls: 9 }),
      engine: ENGINE_CODEX,
      bootstrap: true,
      users: SUPPLIED_USERS,
    });

    expect(hostUserSelects(db)).toEqual([]);
    expect(out.host_users).toEqual(SUPPLIED_USERS);
    expect(out.versions).toBe(SNAPSHOT);
    expect(versions.calls).toEqual([ENGINE_CODEX]);
    expect(out.api_calls).toBe(9);
    expect(out.bootstrap).toBe(true);
  });
});

describe('HostSyncService.recordHostUser', () => {
  const blankCases: Array<{ label: string; username: string | null }> = [
    { label: 'an empty string', username: '' },
    { label: 'whitespace only', username: '   ' },
    { label: 'null', username: null },
  ];

  it.each(blankCases)('records nothing for $label but still returns the current users', async ({ username }) => {
    const db = makeDb([userRow(1, HOST_ID, 'alice', 'alice-box')]);

    const out = await makeService(db, makeVersions()).recordHostUser(HOST_ID, username, 'ignored-box');

    expect(db.inserts).toEqual([]);
    expect(out).toEqual([{ username: 'alice', hostname: 'alice-box', last_seen: '2026-01-02T00:00:00Z' }]);
  });

  it('records the trimmed username with first/last seen and omits a null hostname', async () => {
    const db = makeDb();

    const out = await makeService(db, makeVersions()).recordHostUser(HOST_ID, '  alice  ', null);

    const inserts = hostUserInserts(db);
    expect(inserts).toHaveLength(1);
    const values = inserts[0]!;
    expect(values['username']).toBe('alice');
    expect(values['hostId']).toBe(HOST_ID);
    expect(values['hostname']).toBeUndefined();
    expect(String(values['firstSeen'])).toMatch(ISO);
    expect(values['lastSeen']).toBe(values['firstSeen']);
    expect(out).toEqual([{ username: 'alice', hostname: null, last_seen: values['lastSeen'] }]);
  });

  it('scopes the returned users to the host id and maps a null hostname column to null', async () => {
    const db = makeDb([
      userRow(1, HOST_ID, 'alice', 'alice-box'),
      userRow(2, HOST_ID + 1, 'mallory', 'other-box'),
      userRow(3, HOST_ID, 'bob', null),
    ]);

    const out = await makeService(db, makeVersions()).recordHostUser(HOST_ID, null, null);

    expect(hostUserSelects(db)).toHaveLength(1);
    expect(out).toEqual([
      { username: 'alice', hostname: 'alice-box', last_seen: '2026-01-02T00:00:00Z' },
      { username: 'bob', hostname: null, last_seen: '2026-01-02T00:00:00Z' },
    ]);
  });

  it('records a supplied hostname', async () => {
    const db = makeDb();

    const out = await makeService(db, makeVersions()).recordHostUser(HOST_ID, 'bob', 'bob-box');

    expect(hostUserInserts(db)[0]?.['hostname']).toBe('bob-box');
    expect(out[0]?.hostname).toBe('bob-box');
  });
});

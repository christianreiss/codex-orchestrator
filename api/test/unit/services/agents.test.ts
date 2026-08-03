/**
 * AGENTS.md / CLAUDE.md document store. The versioning rules live entirely in
 * this service -- per-engine state rows, the locked-mode fallback that heals a
 * dangling pin, the dedup short-circuit and the cross-engine prune -- and the
 * admin routes hand raw JSON straight to it, so the validation messages and the
 * served/latest/active flags are contract surface.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentsDocuments, agentsDocumentState, hosts } from '../../../src/db/schema.js';
import { ApiError, NotFoundError, ValidationError } from '../../../src/http/errors.js';
import { AgentsService } from '../../../src/services/agents.js';
import { defaultAgentPolicyComposition } from '../../../src/services/agent-policy-composer.js';
import type { Engine } from '../../../src/util/engine.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

const TS = '2026-07-28T09:00:00Z';

type Row = Record<string, unknown>;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * db-fake ignores `orderBy`, so `agents_documents` is kept newest-first: the
 * service's `orderBy(desc(id)).limit(1)` then lands on the highest id the way
 * MySQL would. The fake's insert builder also has no `$returningId`, which
 * store() and revertVersion() both call.
 */
function makeDb(): DbFake {
  const db = createDbFake(new Map<unknown, Row[]>([
    [agentsDocuments, []],
    [agentsDocumentState, []],
  ]));
  const insert = db.insert.bind(db);
  db.insert = (table: unknown) => {
    if (table !== agentsDocuments) return insert(table);
    return {
      values: (vals: Row) => {
        const rows = db.tables.get(agentsDocuments) ?? [];
        const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1;
        rows.unshift({ id, ...vals });
        db.tables.set(agentsDocuments, rows);
        const result = Promise.resolve([{ insertId: id, affectedRows: 1 }]);
        return Object.assign(result, { $returningId: async () => [{ id }] });
      },
    };
  };
  return db;
}

function makeService(db: DbFake, backupLimit: number | null = null): AgentsService {
  return new AgentsService(db as never, async () => backupLimit);
}

interface DocSeed {
  id: number;
  body: string;
  engine?: Engine;
  /** Rows written before the column existed carry a null digest. */
  sha256?: string | null;
}

function seedDocs(db: DbFake, docs: DocSeed[]): void {
  db.tables.set(
    agentsDocuments,
    docs
      .slice()
      .sort((a, b) => b.id - a.id)
      .map((doc) => ({
        id: doc.id,
        sha256: doc.sha256 === undefined ? sha256Hex(doc.body) : doc.sha256,
        body: doc.body,
        sourceHostId: null,
        engine: doc.engine ?? 'codex',
        createdAt: TS,
        updatedAt: TS,
      })),
  );
}

function seedState(db: DbFake, states: Array<{ id: number; mode: string; activeDocumentId: number | null; engine: Engine }>): void {
  db.tables.set(
    agentsDocumentState,
    states.map((s) => ({ ...s, createdAt: TS, updatedAt: TS })),
  );
}

function stateRows(db: DbFake): Row[] {
  return db.tables.get(agentsDocumentState) ?? [];
}

function documentIds(db: DbFake): number[] {
  return (db.tables.get(agentsDocuments) ?? []).map((row) => row.id as number);
}

/** Resolve to the error a call threw, failing the test if it resolved instead. */
async function caught(promise: Promise<unknown>): Promise<ApiError> {
  return await promise.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (err: ApiError) => err,
  );
}

describe('agents admin view', () => {
  it('reports missing on an empty store and seeds a state row per engine', async () => {
    const db = makeDb();
    const svc = makeService(db);

    const view = await svc.adminFetch();
    expect(view.status).toBe('missing');
    expect(view.served_id).toBeNull();
    expect(view.latest_id).toBeNull();
    expect(view.active_id).toBeNull();
    expect(view.mode).toBe('latest');
    expect(view.engine).toBe('codex');
    expect(view.backup_limit).toBeNull();
    expect(view.versions).toEqual([]);
    expect(view.content).toBeUndefined();

    const claudeView = await svc.adminFetch('claude');
    expect(claudeView.status).toBe('missing');

    // codex takes state row id 1, claude id 2 (the legacy convention).
    expect(stateRows(db).map((row) => ({ id: row.id, mode: row.mode, engine: row.engine, active: row.activeDocumentId })))
      .toEqual([
        { id: 1, mode: 'latest', engine: 'codex', active: null },
        { id: 2, mode: 'latest', engine: 'claude', active: null },
      ]);
  });

  it('flags latest, active and served independently once versions exist', async () => {
    const db = makeDb();
    seedDocs(db, [
      { id: 1, body: 'one' },
      { id: 2, body: 'two' },
      { id: 3, body: 'claude one', engine: 'claude' },
    ]);
    seedState(db, [{ id: 1, mode: 'locked', activeDocumentId: 1, engine: 'codex' }]);
    const svc = makeService(db, 25);

    const view = await svc.adminFetch();
    expect(view.status).toBe('ok');
    expect(view.mode).toBe('locked');
    expect(view.active_id).toBe(1);
    expect(view.served_id).toBe(1);
    // latest_id is the newest row of any engine, not of the served engine.
    expect(view.latest_id).toBe(3);
    expect(view.backup_limit).toBe(25);
    expect(view.content).toBe('one');
    expect(view.sha256).toBe(sha256Hex('one'));
    expect(view.size_bytes).toBe(3);
    expect(view.updated_at).toBe(TS);

    expect(view.versions.map((v) => [v.id, v.is_latest, v.is_active, v.is_served])).toEqual([
      [3, true, false, false],
      [2, false, false, false],
      [1, false, true, true],
    ]);
  });

  it('returns a single version with its flags and rejects an absent one', async () => {
    const db = makeDb();
    seedDocs(db, [{ id: 1, body: 'one' }, { id: 2, body: 'two' }]);
    const svc = makeService(db);

    const version = await svc.adminFetchVersion(1);
    expect(version).toMatchObject({
      id: 1,
      sha256: sha256Hex('one'),
      content: 'one',
      size_bytes: 3,
      is_latest: false,
      is_active: false,
      is_served: false,
    });

    const missing = await caught(svc.adminFetchVersion(9));
    expect(missing).toBeInstanceOf(ValidationError);
    expect(missing.message).toBe('version_id not found');
  });

  it('digests the body of a row that stored no sha256', async () => {
    const db = makeDb();
    seedDocs(db, [{ id: 1, body: 'légacy', sha256: null }]);
    const svc = makeService(db);

    // size_bytes is the utf8 length, not the string length.
    const view = await svc.adminFetch();
    expect(view).toMatchObject({ status: 'ok', sha256: sha256Hex('légacy'), size_bytes: 7 });
    expect(view.versions).toEqual([
      expect.objectContaining({ id: 1, sha256: sha256Hex('légacy'), size_bytes: 7 }),
    ]);

    expect(await svc.adminFetchVersion(1)).toMatchObject({ sha256: sha256Hex('légacy'), size_bytes: 7 });
  });
});

describe('agents served-version resolution', () => {
  it('serves the newest row of the requested engine', async () => {
    const db = makeDb();
    seedDocs(db, [
      { id: 1, body: 'c1', engine: 'claude' },
      { id: 2, body: 'c2', engine: 'claude' },
      { id: 3, body: 'x1' },
    ]);
    const svc = makeService(db);

    const view = await svc.adminFetch('claude');
    expect(view.served_id).toBe(2);
    expect(view.latest_id).toBe(3);
    expect(view.content).toBe('c2');
  });

  it('falls back to the newest row of any engine when the engine has none', async () => {
    const db = makeDb();
    seedDocs(db, [{ id: 1, body: 'x1' }, { id: 2, body: 'x2' }]);
    const svc = makeService(db);

    const view = await svc.adminFetch('claude');
    expect(view.status).toBe('ok');
    expect(view.served_id).toBe(2);
    expect(view.content).toBe('x2');
  });

  it('resets a lock that points at a deleted version', async () => {
    const db = makeDb();
    seedDocs(db, [{ id: 1, body: 'one' }, { id: 2, body: 'two' }]);
    seedState(db, [{ id: 1, mode: 'locked', activeDocumentId: 99, engine: 'codex' }]);
    const svc = makeService(db);

    const view = await svc.adminFetch();
    expect(view.served_id).toBe(2);
    expect(stateRows(db)[0]).toMatchObject({ id: 1, mode: 'latest', activeDocumentId: null });
  });
});

describe('agents store', () => {
  it('rejects a non-string content', async () => {
    const svc = makeService(makeDb());

    const err = await caught(svc.store(null, null));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('content is required');
    expect(err.param).toBe('content');
  });

  it('rejects a sha256 that is neither the body digest nor blank', async () => {
    const svc = makeService(makeDb());

    const malformed = await caught(svc.store('alpha', 'deadbeef'));
    expect(malformed.message).toBe('sha256 must be 64 hex characters');
    expect(malformed.param).toBe('sha256');

    const nonString = await caught(svc.store('alpha', 42));
    expect(nonString.message).toBe('sha256 must be a string');

    const mismatch = await caught(svc.store('alpha', 'a'.repeat(64)));
    expect(mismatch).toBeInstanceOf(ValidationError);
    expect(mismatch.message).toBe('sha256 does not match AGENTS.md contents');

    // Blank and correct-but-uppercase digests are both accepted.
    expect((await svc.store('alpha', '  ')).status).toBe('created');
    expect((await svc.store('alpha', sha256Hex('alpha').toUpperCase())).status).toBe('unchanged');
  });

  it('dedups only against the newest row of the same engine', async () => {
    const db = makeDb();
    const svc = makeService(db);

    const created = await svc.store('alpha', null);
    expect(created).toMatchObject({
      status: 'created',
      version_id: 1,
      sha256: sha256Hex('alpha'),
      size_bytes: 5,
      pruned_count: 0,
    });

    const repeat = await svc.store('alpha', null);
    expect(repeat).toMatchObject({ status: 'unchanged', version_id: 1, pruned_count: 0 });

    // Same body, other engine: dedup is scoped per engine.
    const claude = await svc.store('alpha', null, null, 'claude');
    expect(claude).toMatchObject({ status: 'created', version_id: 2 });

    // Once a different body is newest, the older identical body is stored again.
    expect((await svc.store('beta', null)).version_id).toBe(3);
    expect(await svc.store('alpha', null)).toMatchObject({ status: 'created', version_id: 4 });

    expect(documentIds(db)).toEqual([4, 3, 2, 1]);
    expect((db.tables.get(agentsDocuments) ?? [])[0]).toMatchObject({ engine: 'codex', sourceHostId: null });
  });

  it('records the source host and the requested engine', async () => {
    const db = makeDb();
    const svc = makeService(db);

    await svc.store('alpha', null, 7, 'claude');
    expect((db.tables.get(agentsDocuments) ?? [])[0]).toMatchObject({ sourceHostId: 7, engine: 'claude' });

    // Unknown engines fall back to codex rather than rejecting.
    await svc.store('beta', null, null, 'gemini');
    expect((db.tables.get(agentsDocuments) ?? [])[0]).toMatchObject({ engine: 'codex' });
  });

  it('stores builder provenance with the rendered body and rehydrates it in admin views', async () => {
    const db = makeDb();
    const svc = makeService(db);
    const composition = {
      ...defaultAgentPolicyComposition(),
      enabled_modules: ['operating_contract', 'security'] as const,
      custom_instructions: 'Keep this custom rule.',
    };

    const created = await svc.storeComposition(composition);
    expect(created.status).toBe('created');
    const row = (db.tables.get(agentsDocuments) ?? [])[0];
    expect(row).toBeDefined();
    if (!row) throw new Error('expected stored agents document');
    expect(row.builderState).toEqual(composition);
    expect(row.body).toContain('## Custom Instructions');

    const view = await svc.adminFetch();
    expect(view.builder_state).toEqual(composition);
    expect(view.builder_catalog.modules).toHaveLength(10);
    expect(view.versions[0]?.builder_mode).toBe(true);
  });

  it('publishes agents.stored for a new version and stays quiet on a dedup', async () => {
    const svc = makeService(makeDb());
    const events: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = wsPublisher.subscribe((e) => events.push({ type: e.type, payload: e.payload }));

    try {
      await svc.store('alpha', null, null, 'claude');
      await svc.store('alpha', null, null, 'claude');
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([
      { type: 'agents.stored', payload: { engine: 'claude', version_id: 1, sha256: sha256Hex('alpha') } },
    ]);
  });
});

describe('agents serve mode', () => {
  it('rejects an unknown mode', async () => {
    const svc = makeService(makeDb());

    const err = await caught(svc.setServeMode('pinned', null));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('mode must be latest or locked');
    expect(err.param).toBe('mode');

    expect((await caught(svc.setServeMode(null, null))).message).toBe('mode must be latest or locked');
  });

  it('rejects a lock without a resolvable version_id', async () => {
    const db = makeDb();
    seedDocs(db, [{ id: 1, body: 'one' }]);
    const svc = makeService(db);

    const missingId = await caught(svc.setServeMode('locked', null));
    expect(missingId.message).toBe('version_id is required to lock');
    expect(missingId.param).toBe('version_id');

    expect((await caught(svc.setServeMode('locked', 0))).message).toBe('version_id is required to lock');
    expect((await caught(svc.setServeMode('locked', 9))).message).toBe('version_id not found');
    // A rejected lock is refused before any state row is touched.
    expect(stateRows(db)).toEqual([]);
  });

  it('locks an older version and releases it again', async () => {
    const db = makeDb();
    seedDocs(db, [{ id: 1, body: 'one' }, { id: 2, body: 'two' }]);
    const svc = makeService(db);

    const locked = await svc.setServeMode('  LOCKED ', 1);
    expect(locked).toMatchObject({ mode: 'locked', active_id: 1, served_id: 1, latest_id: 2, content: 'one' });

    const released = await svc.setServeMode('latest', 1);
    expect(released).toMatchObject({ mode: 'latest', active_id: null, served_id: 2, content: 'two' });
  });

  it('reverts by appending a copy and unlocking', async () => {
    const db = makeDb();
    seedDocs(db, [{ id: 1, body: 'one' }, { id: 2, body: 'two' }]);
    seedState(db, [{ id: 1, mode: 'locked', activeDocumentId: 1, engine: 'codex' }]);
    const svc = makeService(db);

    const view = await svc.revertVersion(1);
    expect(view).toMatchObject({ mode: 'latest', active_id: null, served_id: 3, content: 'one' });
    expect(documentIds(db)).toEqual([3, 2, 1]);

    expect((await caught(svc.revertVersion(0))).message).toBe('version_id is required');
    expect((await caught(svc.revertVersion(9))).message).toBe('version_id not found');
  });
});

describe('agents version deletion', () => {
  it('refuses the served version but deletes a historical one', async () => {
    const db = makeDb();
    seedDocs(db, [{ id: 1, body: 'one' }, { id: 2, body: 'two' }]);
    const svc = makeService(db);

    const err = await caught(svc.deleteVersion(2));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('cannot delete the served version');
    expect(err.param).toBe('version_id');

    const view = await svc.deleteVersion(1);
    expect(view.versions.map((v) => v.id)).toEqual([2]);
    expect(documentIds(db)).toEqual([2]);
  });

  it('raises version_not_found for an absent id', async () => {
    const db = makeDb();
    seedDocs(db, [{ id: 1, body: 'one' }]);
    const svc = makeService(db);

    const err = await caught(svc.deleteVersion(9));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('version_not_found');
    expect(err.status).toBe(404);

    expect((await caught(svc.deleteVersion(0))).message).toBe('version_id is required');
  });
});

describe('agents backup retention', () => {
  it('maps 0 and the empty string to null and rejects out-of-range or fractional limits', async () => {
    const svc = makeService(makeDb());
    const seen: Array<number | null> = [];
    const setter = async (value: number | null): Promise<void> => {
      seen.push(value);
    };

    expect(await svc.updateBackupRetention(0, setter)).toEqual({ backup_limit: null, pruned_count: 0 });
    expect(await svc.updateBackupRetention('', setter)).toEqual({ backup_limit: null, pruned_count: 0 });
    expect(await svc.updateBackupRetention(null, setter)).toEqual({ backup_limit: null, pruned_count: 0 });
    expect(await svc.updateBackupRetention('5', setter)).toEqual({ backup_limit: 5, pruned_count: 0 });
    expect(await svc.updateBackupRetention(200, setter)).toEqual({ backup_limit: 200, pruned_count: 0 });
    expect(seen).toEqual([null, null, null, 5, 200]);

    const tooLarge = await caught(svc.updateBackupRetention(201, setter));
    expect(tooLarge).toBeInstanceOf(ValidationError);
    expect(tooLarge.message).toBe('backup_limit must be between 0 and 200');
    expect(tooLarge.param).toBe('backup_limit');

    expect((await caught(svc.updateBackupRetention(-1, setter))).message).toBe('backup_limit must be between 0 and 200');
    expect((await caught(svc.updateBackupRetention(1.5, setter))).message)
      .toBe('backup_limit must be an integer between 0 and 200');
    expect((await caught(svc.updateBackupRetention('abc', setter))).message)
      .toBe('backup_limit must be an integer between 0 and 200');

    // A rejected limit never reaches the setter.
    expect(seen).toHaveLength(5);
  });

  it('prunes rows beyond the limit while protecting every engine lock', async () => {
    const db = makeDb();
    seedDocs(db, [
      { id: 1, body: 'one' },
      { id: 2, body: 'two' },
      { id: 3, body: 'c1', engine: 'claude' },
      { id: 4, body: 'c2', engine: 'claude' },
      { id: 5, body: 'five' },
      { id: 6, body: 'six' },
    ]);
    seedState(db, [
      { id: 1, mode: 'locked', activeDocumentId: 2, engine: 'codex' },
      { id: 2, mode: 'locked', activeDocumentId: 3, engine: 'claude' },
    ]);
    const svc = makeService(db);
    const setter = async (): Promise<void> => {};

    // The scan spans both engines: eligible = 6,5,4,1 and the two locked ids
    // survive regardless of age.
    expect(await svc.updateBackupRetention(2, setter)).toEqual({ backup_limit: 2, pruned_count: 2 });
    expect(documentIds(db)).toEqual([6, 5, 3, 2]);

    // Nothing left beyond the limit.
    expect(await svc.updateBackupRetention(10, setter)).toEqual({ backup_limit: 10, pruned_count: 0 });
    expect(documentIds(db)).toEqual([6, 5, 3, 2]);
  });

  it('protects a version pinned by a host, not just the fleet-wide lock', async () => {
    // Only `agents_document_state` locks used to be protected, so a retention
    // sweep could delete the exact row a host pinned via
    // `hosts.agents_document_id_override`. `resolveServedDocument` then logs
    // `agents.host_override_missing` and silently serves latest -- a host moved
    // onto a different policy by a background sweep, which is the one thing a
    // pin exists to prevent.
    const db = makeDb();
    seedDocs(db, [
      { id: 1, body: 'one' },
      { id: 2, body: 'two' },
      { id: 3, body: 'three' },
      { id: 4, body: 'four' },
    ]);
    db.tables.set(hosts, [
      { id: 10, agentsDocumentIdOverride: 1 },
      { id: 11, agentsDocumentIdOverride: null },
    ] as Row[]);
    const svc = makeService(db);

    expect(await svc.updateBackupRetention(2, async () => {})).toEqual({
      backup_limit: 2,
      pruned_count: 1,
    });
    // 4 and 3 are within the limit; 1 survives on its pin; only 2 goes.
    expect(documentIds(db)).toEqual([4, 3, 1]);
  });

  it('prunes on store with the freshly created row protected', async () => {
    const db = makeDb();
    seedDocs(db, [{ id: 1, body: 'one' }, { id: 2, body: 'two' }]);
    const svc = makeService(db, 1);

    expect(await svc.store('three', null)).toMatchObject({ status: 'created', version_id: 3, pruned_count: 1 });
    expect(documentIds(db)).toEqual([3, 2]);

    // An unchanged store never prunes.
    expect(await svc.store('three', null)).toMatchObject({ status: 'unchanged', pruned_count: 0 });
    expect(documentIds(db)).toEqual([3, 2]);
  });
});

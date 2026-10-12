import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { ModelDefaultsService } from '../../../src/services/model-defaults.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINE_GROK, type Engine } from '../../../src/util/engine.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb();

// The fake DB cannot prove range locking or transaction visibility. Run these
// with TEST_USE_DB=1 and --no-file-parallelism against a disposable MySQL DB.
describe.skipIf(!handle)('atomic configuration revisions against MySQL', () => {
  const ownedIds = new Set<number>();
  const engines = [ENGINE_CODEX, ENGINE_CLAUDE, ENGINE_GROK];
  const service = () => new ClientConfigService(handle!.db);
  const remember = (revision: string | null) => {
    if (revision !== null) ownedIds.add(Number(revision));
  };
  async function store(engine: Engine, settings: unknown, expected_revision?: string | null) {
    const result = await service().store({ settings, expected_revision }, null, engine);
    if (result.change !== 'unchanged') remember(result.revision);
    return result;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    if (ownedIds.size) await handle!.db.delete(clientConfigDocuments).where(inArray(clientConfigDocuments.id, [...ownedIds]));
    ownedIds.clear();
  });
  afterAll(async () => { await handle?.pool.end(); });

  it.each(engines)('allows one winner for two %s writers using the same revision', async engine => {
    const initial = await store(engine, { orchestrator_mcp_enabled: true });
    const outcomes = await Promise.allSettled([
      store(engine, { orchestrator_mcp_enabled: false }, initial.revision),
      store(engine, { orchestrator_mcp_enabled: false, mcp_servers: [{ name: 'revision-test', command: 'test-mcp' }] }, initial.revision),
    ]);
    const winner = outcomes.find(result => result.status === 'fulfilled');
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find(result => result.status === 'rejected');
    expect(loser && 'reason' in loser && loser.reason).toMatchObject({ status: 409, code: 'config_revision_conflict' });
    expect((await service().adminFetch(engine)).revision).toBe(winner && 'value' in winner && winner.value.revision);
  });

  it('atomically rejects the losing create with expected_revision:null', async () => {
    // A unique test-only engine key isolates the empty-range case without
    // deleting pre-existing canonical documents. Rendering follows Codex.
    const engine = `rev-${randomUUID().slice(0, 8)}` as Engine;
    expect(await service().adminFetch(engine)).toEqual({ status: 'missing', revision: null });
    const outcomes = await Promise.allSettled([
      store(engine, { orchestrator_mcp_enabled: true }, null),
      store(engine, { orchestrator_mcp_enabled: false }, null),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find(result => result.status === 'rejected');
    expect(loser && 'reason' in loser && loser.reason).toMatchObject({ status: 409, code: 'config_revision_conflict' });
  });

  it.each(engines)('detects %s settings-only edits with an unchanged rendered hash', async engine => {
    const initial = await store(engine, { orchestrator_mcp_enabled: true });
    const updated = await store(engine, { ...initial.settings, orchestrator_mcp_enabled: false }, initial.revision);
    expect(updated.sha256).toBe(initial.sha256);
    expect(updated.content).toBe(initial.content);
    expect(updated.revision).not.toBe(initial.revision);
    expect(updated.change).toBe('updated');
    await expect(store(engine, initial.settings, initial.revision)).rejects.toMatchObject({
      status: 409, code: 'config_revision_conflict',
      extra: { current_revision: updated.revision, expected_revision: initial.revision },
    });
    const unchanged = await store(engine, updated.settings, updated.revision);
    expect(unchanged.revision).toBe(updated.revision);
    expect(unchanged.change).toBe('unchanged');
  });

  it.each(engines)('serializes %s model-default read/merge/write with config writes', async engine => {
    const initial = await store(engine, { orchestrator_mcp_enabled: true });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const originalStore = ClientConfigService.prototype.store;
    let paused = false;
    vi.spyOn(ClientConfigService.prototype, 'store').mockImplementation(async function (this: ClientConfigService, payload, sourceHostId, selectedEngine) {
      if (!paused && selectedEngine === engine && payload.expected_revision === initial.revision) {
        paused = true;
        entered();
        await gate;
      }
      return originalStore.call(this, payload, sourceHostId, selectedEngine);
    });
    const defaults = new ModelDefaultsService(handle!.db);
    const current = await defaults.get(engine);
    const selected = current.catalog.find(entry => entry.model !== current.model)!;
    const modelUpdate = defaults.set(engine, { model: selected.model });
    await started;
    const configUpdate = store(engine, { ...initial.settings, orchestrator_mcp_enabled: false }, initial.revision);
    // Both requests are pending while the model-default transaction holds the
    // lock. Releasing it must make the stale config write fail, not erase it.
    release();
    const outcomes = await Promise.allSettled([modelUpdate, configUpdate]);
    const final = await service().adminFetch(engine);
    if (final.revision !== initial.revision) remember(final.revision);
    expect(outcomes[0]?.status).toBe('fulfilled');
    expect(outcomes[1]?.status).toBe('rejected');
    expect(outcomes[1] && 'reason' in outcomes[1] && outcomes[1].reason).toMatchObject({ status: 409, code: 'config_revision_conflict' });
    expect(final.settings).toMatchObject({ model: selected.model, orchestrator_mcp_enabled: true });
  });
});

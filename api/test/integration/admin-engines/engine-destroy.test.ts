import { describe, expect, it, vi } from 'vitest';
import { engineDestroyHosts, hosts, versions } from '../../../src/db/schema.js';
import {
  destroyDirectivesForHost,
  destroyTargetsHost,
  listDestroyProgress,
  purgeEngineServerData,
  recordHostReport,
  requestEngineDestroy,
} from '../../../src/services/engine-destroy.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake } from '../../helpers/db-fake.js';

/*
 * Database-handle (non-owner) branch of the fleet "destroy engine" flow. The
 * owner-runtime branch is covered in test/unit/control-plane/daemon-owned.test.ts.
 */
const host = (id: number, engines: string, extra: Record<string, unknown> = {}) => ({
  id, fqdn: `h${id}.example`, engines, status: 'active', configVersion: 0, internalRole: null, ...extra,
});

function build(hostRows: Array<Record<string, unknown>>) {
  vi.spyOn(wsPublisher, 'publish').mockImplementation(() => undefined as never);
  const db = createDbFake(new Map<unknown, Array<Record<string, unknown>>>([
    [versions, [{ name: 'grok_engine_disabled', version: '1' }]],
    [hosts, hostRows],
    [engineDestroyHosts, []],
  ]));
  invalidateFleetEngineState(db as never);
  return db;
}

describe('engine destroy targeting (database branch)', () => {
  it('names carriers and hosts that once reported the engine, never untouched hosts', () => {
    expect(destroyTargetsHost(host(1, 'codex,grok'), 'grok')).toBe(true);
    expect(destroyTargetsHost(host(2, 'codex', { grokClientVersion: '1.0.77' }), 'grok')).toBe(true);
    expect(destroyTargetsHost(host(3, 'codex', { grokAuthDigest: 'd'.repeat(64) }), 'grok')).toBe(true);
    expect(destroyTargetsHost(host(4, 'codex,claude', { kimiClientVersion: '2.6.1' }), 'grok')).toBe(false);
  });

  it('opens progress rows for every targeted host, including one that dropped the engine', async () => {
    const db = build([host(1, 'codex,grok'), host(2, 'codex', { grokClientVersion: '1.0.77' }), host(3, 'codex')]);
    const result = await requestEngineDestroy(db as never, 'grok', 'grok', 'ops');
    expect(result.hosts_targeted).toBe(2);
    expect((db.tables.get(engineDestroyHosts) ?? []).map((row) => row.hostId).sort()).toEqual([1, 2]);
    expect(await destroyDirectivesForHost(db as never, 2)).toEqual([{ engine: 'grok', request_id: result.request.request_id }]);
    expect(await destroyDirectivesForHost(db as never, 3)).toEqual([]);
  });

  it('reaches a host targeted after the request and records its first report', async () => {
    const db = build([host(1, 'codex,grok'), host(2, 'codex')]);
    const { request } = await requestEngineDestroy(db as never, 'grok', 'grok', 'ops');
    await recordHostReport(db as never, 1, { engine: 'grok', request_id: request.request_id, status: 'done' });
    // Host 2 comes back reporting an old Grok install after the request opened.
    Object.assign(db.tables.get(hosts)![1]!, { grokClientVersion: '1.0.50' });

    expect(await destroyDirectivesForHost(db as never, 2)).toEqual([{ engine: 'grok', request_id: request.request_id }]);
    const progress = await listDestroyProgress(db as never, 'grok');
    expect(progress.counts).toMatchObject({ pending: 1, done: 1 });
    expect(progress.hosts.find((row) => row.host_id === 2)).toMatchObject({ fqdn: 'h2.example', status: 'pending' });
    await expect(purgeEngineServerData(db as never, 'grok', { force: false, actor: 'ops' })).rejects.toThrow('have not completed');

    expect(await recordHostReport(db as never, 2, { engine: 'grok', request_id: request.request_id, status: 'done' })).toEqual({ recorded: true });
    expect(db.tables.get(engineDestroyHosts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: request.request_id, hostId: 2, engine: 'grok', status: 'done' }),
    ]));
    expect((await listDestroyProgress(db as never, 'grok')).counts).toMatchObject({ pending: 0, done: 2 });
  });

  it('refuses a report from a host the request does not target', async () => {
    const db = build([host(1, 'codex,grok'), host(2, 'codex')]);
    const { request } = await requestEngineDestroy(db as never, 'grok', 'grok', 'ops');
    expect(await recordHostReport(db as never, 2, { engine: 'grok', request_id: request.request_id, status: 'done' })).toEqual({ recorded: false });
    expect((db.tables.get(engineDestroyHosts) ?? []).map((row) => row.hostId)).toEqual([1]);
  });

  it('hides internal hosts from progress', async () => {
    const db = build([host(1, 'codex,grok'), host(2, 'codex,grok', { internalRole: 'advisor', fqdn: 'advisor.internal' })]);
    await requestEngineDestroy(db as never, 'grok', 'grok', 'ops');
    const progress = await listDestroyProgress(db as never, 'grok');
    expect(progress.hosts.map((row) => row.host_id)).toEqual([1]);
    expect(progress.counts.pending).toBe(1);
  });
});

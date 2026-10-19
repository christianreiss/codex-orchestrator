import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hosts, installTokens, hostAuthStates, hostAuthDigests, hostUsers, logs, adminEvents, type Host } from '../../../src/db/schema.js';
import { pruneHosts, recordHostContact } from '../../../src/services/host-lifecycle.js';
import { HostManagementService } from '../../../src/services/host-management.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import type { SettingsService } from '../../../src/services/settings.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
const handle = await getTestDb();
const now = new Date('2026-10-11T16:00:00Z');
const settings = { getInt: async () => 0 } as unknown as SettingsService;
describe.skipIf(!handle)('host lifecycle and installer transactions on MySQL', () => {
  const ids: number[] = []; let management: HostManagementService;
  beforeAll(() => { management = new HostManagementService({ db: handle!.db, env: { ...loadTestEnv(), PUBLIC_BASE_URL: 'https://lifecycle.test' }, keyring: testKeyring(), events: makeAdminEventsWriter(handle!.db) }); });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (!ids.length) return;
    for (const table of [installTokens, hostAuthStates, hostAuthDigests, hostUsers, logs, adminEvents]) await handle!.db.delete(table).where(inArray(table.hostId, ids));
    await handle!.db.delete(hosts).where(inArray(hosts.id, ids)); ids.length = 0;
  });
  afterAll(async () => { await handle?.pool.end(); });
  async function seed(patch: Partial<Host> = {}) {
    const result = await handle!.db.insert(hosts).values({ fqdn: `${randomUUID()}.lifecycle.test`, apiKey: randomUUID(), createdAt: '2026-10-11T15:00:00Z', updatedAt: '2026-10-11T15:00:00Z', ...patch });
    const id = Number(result[0].insertId); ids.push(id);
    return (await handle!.db.select().from(hosts).where(eq(hosts.id, id)))[0]!;
  }
  it.each(['codex', 'claude', 'grok'])('renews %s pooled hosts and removes abandoned/expired hosts with dependent state', async engines => {
    const db = handle!.db;
    const live = await seed({ engines, apiCalls: 1, expiresAt: '2026-10-11T16:01:00Z' });
    const abandoned = await seed({ engines });
    await db.insert(installTokens).values({ hostId: abandoned.id, token: randomUUID(), apiKey: 'hash', fqdn: abandoned.fqdn, engine: engines, expiresAt: '2026-10-11T16:30:00Z', createdAt: '2026-10-11T15:00:00Z' });
    await db.insert(hostUsers).values({ hostId: abandoned.id, username: 'installer', firstSeen: '2026-10-11T15:00:00Z', lastSeen: '2026-10-11T15:00:00Z' });
    await recordHostContact(db, live, now); await pruneHosts(db, settings, now);
    expect(await db.select().from(hosts).where(eq(hosts.id, abandoned.id))).toEqual([]);
    expect(await db.select().from(installTokens).where(eq(installTokens.hostId, abandoned.id))).toEqual([]);
    expect(await db.select().from(hostUsers).where(eq(hostUsers.hostId, abandoned.id))).toEqual([]);
    expect((await db.select().from(hosts).where(eq(hosts.id, live.id)))[0]?.expiresAt).toBe('2026-10-11T18:00:00Z');
    await pruneHosts(db, settings, new Date('2026-10-11T18:00:00Z'));
    expect(await db.select().from(hosts).where(eq(hosts.id, live.id))).toEqual([]);
  });
  it('rechecks stale snapshots after waiting for the contact transaction host lock', async () => {
    const db = handle!.db; const host = await seed();
    const transaction = db.transaction.bind(db);
    let signal!: () => void; const started = new Promise<void>(resolve => { signal = resolve; });
    let sweep!: Promise<number>;
    await transaction(async tx => {
      await tx.select().from(hosts).where(eq(hosts.id, host.id)).for('update');
      vi.spyOn(db, 'transaction').mockImplementationOnce(async (...args) => { signal(); return transaction(...args); });
      sweep = pruneHosts(db, settings, now);
      await started;
      await tx.update(hosts).set({ lastContactAt: '2026-10-11T16:00:00Z', updatedAt: '2026-10-11T16:00:00Z' }).where(eq(hosts.id, host.id));
    });
    await sweep;
    expect(await db.select().from(hosts).where(eq(hosts.id, host.id))).toHaveLength(1);
  });
  it('compares an engine no-op against the row acquired after a concurrent change', async () => {
    const db = handle!.db; const host = await seed({ engines: 'codex', apiCalls: 1 });
    const transaction = db.transaction.bind(db);
    let signal!: () => void; const started = new Promise<void>(resolve => { signal = resolve; });
    let change!: Promise<Host>;
    await transaction(async tx => {
      await tx.select().from(hosts).where(eq(hosts.id, host.id)).for('update');
      vi.spyOn(db, 'transaction').mockImplementationOnce(async (...args) => { signal(); return transaction(...args); });
      change = management.setEngines(host.id, ['codex']);
      await started;
      await tx.update(hosts).set({ engines: 'claude' }).where(eq(hosts.id, host.id));
    });
    expect((await change).engines).toBe('codex');
    expect((await db.select().from(hosts).where(eq(hosts.id, host.id)))[0]?.engines).toBe('codex');
    const audit = (await db.select().from(logs).where(eq(logs.hostId, host.id))).find(row => row.action === 'admin.host.engines');
    expect(JSON.parse(audit!.details!)).toMatchObject({ previous: 'claude', engines: 'codex' });
  });
  it('rolls token replacement back when insertion fails after deleting the prior token', async () => {
    const db = handle!.db; const registered = await management.register({ fqdn: `${randomUUID()}.mint.test` }); ids.push(registered.host.id);
    const prior = await db.select().from(installTokens).where(eq(installTokens.hostId, registered.host.id));
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async callback => transaction(async tx => {
      const insert = tx.insert.bind(tx);
      vi.spyOn(tx, 'insert').mockImplementation(((table: any) => {
        if (table === installTokens) throw new Error('injected token insert failure');
        return insert(table);
      }) as typeof tx.insert);
      return callback(tx);
    }));
    await expect(management.mintInstaller(registered.host.id)).rejects.toThrow('injected token insert failure');
    expect(await db.select().from(installTokens).where(eq(installTokens.hostId, registered.host.id))).toEqual(prior);
  });
});

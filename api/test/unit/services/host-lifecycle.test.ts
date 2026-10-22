import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { hosts, hostAuthStates, hostAuthDigests, hostUsers, installTokens, authPayloads, logs, type Host } from '../../../src/db/schema.js';
import { pruneHosts, recordHostContact } from '../../../src/services/host-lifecycle.js';
import { makeAuthHostPlugin } from '../../../src/http/plugins/auth-host.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import type { SettingsService } from '../../../src/services/settings.js';
const now = new Date('2026-10-11T16:00:00Z');
const settings = { getInt: async () => 0 } as unknown as SettingsService;
function row(patch: Partial<Host> = {}): Host {
  return { id: 1, fqdn: 'lifecycle.test', status: 'active', engines: 'codex', apiCalls: 0,
    createdAt: '2026-10-11T15:00:00Z', updatedAt: '2026-10-11T15:00:00Z', ...patch } as Host;
}
function setup(rows: Host[]) {
  const db = createDbFake(); db.tables.set(hosts, rows as any); return db;
}
describe('host lifecycle', () => {
  it('checkpoints permanent-host contact once per 30 seconds without caching admission', async () => {
    const live = row({ apiCalls: 1 });
    const db = setup([live]);
    await recordHostContact(db as any, live, now);
    const transactions = db.transactions.length;
    for (let i = 1; i < 30; i++) await recordHostContact(db as any, live, new Date(now.getTime() + i * 1000));
    expect(db.updates.filter(update => update.table === hosts)).toHaveLength(1);
    expect(db.transactions).toHaveLength(transactions);
    await recordHostContact(db as any, live, new Date(now.getTime() + 30_000));
    expect(db.updates.filter(update => update.table === hosts)).toHaveLength(2);
    db.tables.set(hosts, [row({ apiKeyHash: 'rotated', lastContactAt: now.toISOString() }) as any]);
    await expect(recordHostContact(db as any, live, now)).rejects.toMatchObject({ code: 'invalid_api_key' });
    db.tables.set(hosts, [row({ status: 'disabled', lastContactAt: now.toISOString() }) as any]);
    await expect(recordHostContact(db as any, live, now)).rejects.toMatchObject({ code: 'host_disabled' });
    db.tables.set(hosts, []);
    await expect(recordHostContact(db as any, live, now)).rejects.toMatchObject({ code: 'invalid_api_key' });
  });
  it('rechecks checkpoint and key changes after acquiring the write lock', async () => {
    const live = row({ apiCalls: 1 });
    const db = setup([live]);
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async cb => {
      db.tables.set(hosts, [{ ...live, lastContactAt: now.toISOString() } as any]);
      return transaction(cb);
    });
    await recordHostContact(db as any, live, now);
    expect(db.updates).toHaveLength(0);
    db.tables.set(hosts, [live as any]);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async cb => {
      db.tables.set(hosts, [{ ...live, apiKeyHash: 'rotated' } as any]);
      return transaction(cb);
    });
    await expect(recordHostContact(db as any, live, now)).rejects.toMatchObject({ code: 'invalid_api_key' });
    expect(db.updates).toHaveLength(0);
  });
  it('prunes abandoned provisioning and expired hosts even when inactivity pruning is off', async () => {
    const db = setup([row(), row({ id: 2, apiCalls: 5, expiresAt: '2026-10-11T15:59:59Z' }), row({ id: 3, createdAt: '2026-10-11T15:31:00Z' })]);
    for (const table of [installTokens, hostUsers, hostAuthStates, hostAuthDigests]) db.tables.set(table, [{ hostId: 1 }, { hostId: 2 }, { hostId: 3 }]);
    db.tables.set(authPayloads, [{ sourceHostId: 1, accountId: 7 }]);
    expect(await pruneHosts(db as any, settings, now)).toBe(2);
    expect(db.tables.get(hosts)?.map(h => h.id)).toEqual([3]);
    for (const table of [installTokens, hostUsers, hostAuthStates, hostAuthDigests]) expect(db.tables.get(table)).toEqual([{ hostId: 3 }]);
    expect(db.tables.get(authPayloads)).toEqual([{ sourceHostId: 1, accountId: 7 }]);
    expect(db.tables.get(logs)?.map(log => JSON.parse(log.details as string).reason)).toEqual(['never_provisioned', 'expired']);
  });
  it.each(['codex', 'claude', 'grok'])('retains %s provisioning metadata and pooled-account contacts', async engine => {
    const version = engine === 'codex' ? 'wrapperVersion' : `${engine}WrapperVersion`;
    const db = setup([row({ engines: engine, [version]: '0.9.45' }), row({ id: 2, engines: engine, apiCalls: 1 })]);
    expect(await pruneHosts(db as any, settings, now)).toBe(0);
  });
  it.each(['codex', 'claude', 'grok'])('renews %s temporary contact for two hours and refuses resurrection', async engine => {
    const live = row({ engines: engine, expiresAt: '2026-10-11T16:01:00Z' });
    const db = setup([live]);
    const touched = await recordHostContact(db as any, live, now);
    expect(touched).toMatchObject({ updatedAt: '2026-10-11T16:00:00Z', expiresAt: '2026-10-11T18:00:00Z' });
    expect(await pruneHosts(db as any, settings, now)).toBe(0);
    await expect(recordHostContact(db as any, live, new Date('2026-10-11T18:00:00Z'))).rejects.toMatchObject({ code: 'host_expired' });
  });
  it('rechecks a stale candidate after a contact wins the row lock', async () => {
    const db = setup([row()]); const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async cb => {
      db.tables.set(hosts, [row({ lastContactAt: '2026-10-11T16:00:00Z', updatedAt: '2026-10-11T16:00:00Z' }) as any]);
      return transaction(cb);
    });
    expect(await pruneHosts(db as any, settings, now)).toBe(0);
    expect(db.tables.get(hosts)).toHaveLength(1);
  });
  it('administrative edits and provider refreshes cannot postpone inactivity pruning', async () => {
    const db = setup([row({ apiCalls: 5, createdAt: '2026-08-01T00:00:00Z', lastContactAt: '2026-08-01T00:00:00Z', updatedAt: now.toISOString(), lastRefresh: now.toISOString() })]);
    expect(await pruneHosts(db as never, { getInt: async () => 30 } as unknown as SettingsService, now)).toBe(1);
  });
  it('rejects expired credentials immediately while leaving cleanup to the retention sweep', async () => {
    const db = setup([row({ createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), apiCalls: 1, apiKeyHash: hashApiKey('good'), expiresAt: new Date(Date.now()+60_000).toISOString() }), row({ id: 2, apiKeyHash: hashApiKey('expired'), expiresAt: '2020-01-01T00:00:00Z' }), row({ id: 3 })]);
    const app = Fastify(); await app.register(makeAuthHostPlugin(db as any));
    app.get('/probe', { preHandler: app.requireHost }, async () => ({ ok: true }));
    try {
      const response = await app.inject({ url: '/probe', headers: { 'x-api-key': 'good' } });
      expect(response.statusCode).toBe(200);
      expect(db.tables.get(hosts)?.map(h => h.id)).toEqual([1, 2, 3]);
      const expiry = Date.parse(db.tables.get(hosts)![0]!.expiresAt as string);
      expect(expiry - Date.now()).toBeGreaterThan(7190_000);
      expect((await app.inject({ url: '/probe', headers: { 'x-api-key': 'expired' } })).statusCode).toBe(401);
      await pruneHosts(db as never, settings);
      expect(db.tables.get(hosts)?.map(h => h.id)).toEqual([1]);
    } finally { await app.close(); }
  });
});

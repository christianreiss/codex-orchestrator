import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hosts, versions, type Host } from '../../../src/db/schema.js';
import { createHostAuthService } from '../../../src/services/host-auth.js';
import { assertReverseDnsMatch } from '../../../src/services/reverse-dns.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv } from '../../helpers/test-keyring.js';

vi.mock('../../../src/services/reverse-dns.js', () => ({
  assertReverseDnsMatch: vi.fn().mockResolvedValue(undefined),
}));
const handle = await getTestDb();
const flagNames = ['api_disabled', 'reverse_dns_enabled'];
describe.skipIf(!handle)('fresh combined transport admission on MySQL', () => {
  const ids: number[] = [];
  let prior: (typeof versions.$inferSelect)[];
  const auth =
    handle &&
    createHostAuthService({ db: handle.db, env: { ...loadTestEnv(), AUTH_RUNNER_IP_BYPASS: false } });
  const opts = { checkApiDisabled: true } as const;
  const request = (key?: string) =>
    ({
      headers: key ? { 'x-api-key': key } : {},
      method: 'POST',
      query: {},
      clientIp: '192.0.2.11',
    }) as FastifyRequest;
  async function flag(name: string, value: string) {
    await handle!.db
      .insert(versions)
      .values({ name, version: value, updatedAt: new Date().toISOString() })
      .onDuplicateKeyUpdate({ set: { version: value } });
  }
  async function seed(patch: Partial<Host> = {}) {
    const key = randomUUID(),
      now = new Date().toISOString();
    const result = await handle!.db
      .insert(hosts)
      .values({
        fqdn: `${randomUUID()}.admission.test`,
        apiKey: key,
        apiKeyHash: hashApiKey(key),
        status: 'active',
        secure: 1,
        ip4: '192.0.2.11',
        reverseDnsMode: null,
        engines: 'codex,claude,grok',
        lastContactAt: now,
        createdAt: now,
        updatedAt: now,
        ...patch,
      });
    const id = Number(result[0].insertId);
    ids.push(id);
    return { id, key };
  }
  beforeAll(async () => {
    prior = await handle!.db.select().from(versions).where(inArray(versions.name, flagNames));
    await flag('api_disabled', '0');
    await flag('reverse_dns_enabled', '0');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(assertReverseDnsMatch).mockReset().mockResolvedValue(undefined);
    if (ids.length) await handle!.db.delete(hosts).where(inArray(hosts.id, ids));
    ids.length = 0;
    await flag('api_disabled', '0');
    await flag('reverse_dns_enabled', '0');
  });
  afterAll(async () => {
    await handle!.db.delete(versions).where(inArray(versions.name, flagNames));
    if (prior.length) await handle!.db.insert(versions).values(prior);
    await handle!.pool.end();
  });

  it('uses one fresh query and isolates concurrent credentials through the same compiled plan', async () => {
    const peers = await Promise.all(['codex', 'claude', 'grok'].map((engines) => seed({ engines })));
    const queries = vi.spyOn(handle!.pool, 'query');
    const connections = vi.spyOn(handle!.pool, 'getConnection');
    try {
      const result = await Promise.all(
        [...peers, ...[...peers].reverse()].map((peer) => auth!.authenticate(request(peer.key), opts)),
      );
      expect(result.map((host) => host.id)).toEqual(
        [...peers, ...[...peers].reverse()].map((peer) => peer.id),
      );
      expect(queries).toHaveBeenCalledTimes(6);
      expect(connections).not.toHaveBeenCalled();
    } finally {
      queries.mockRestore();
      connections.mockRestore();
    }
  });

  it('keeps hash-first and legacy variants fresh across key rotation and status changes', async () => {
    const hashed = await seed(),
      legacy = await seed({ apiKeyHash: null });
    expect((await auth!.authenticate(request(legacy.key), opts)).id).toBe(legacy.id);
    expect((await auth!.authenticate(request(hashed.key), opts)).id).toBe(hashed.id);
    const next = randomUUID();
    await handle!.db
      .update(hosts)
      .set({ apiKey: next, apiKeyHash: hashApiKey(next) })
      .where(eq(hosts.id, hashed.id));
    await expect(auth!.authenticate(request(hashed.key), opts)).rejects.toMatchObject({
      code: 'invalid_api_key',
    });
    expect((await auth!.authenticate(request(next), opts)).id).toBe(hashed.id);
    await handle!.db.update(hosts).set({ status: 'inactive' }).where(eq(hosts.id, legacy.id));
    await expect(auth!.authenticate(request(legacy.key), opts)).rejects.toMatchObject({
      code: 'host_inactive',
    });
  });

  it('refuses disabled admission before binding, DNS or checkpoint side effects, including absent credentials', async () => {
    const peer = await seed({ ip4: null, lastContactAt: '2000-01-01T00:00:00Z' });
    await flag('api_disabled', '1');
    await flag('reverse_dns_enabled', '1');
    const tx = vi.spyOn(handle!.db, 'transaction');
    try {
      for (const key of [peer.key, randomUUID(), undefined])
        await expect(auth!.authenticate(request(key), opts)).rejects.toMatchObject({ code: 'api_disabled' });
      expect(tx).not.toHaveBeenCalled();
      expect(assertReverseDnsMatch).not.toHaveBeenCalled();
      const [row] = await handle!.db.select().from(hosts).where(eq(hosts.id, peer.id));
      expect(row).toMatchObject({ ip4: null, lastContactAt: '2000-01-01T00:00:00Z' });
    } finally {
      tx.mockRestore();
    }
  });

  it('retains strict kill-switch values and fresh inherited versus explicit reverse-DNS policy', async () => {
    const peer = await seed();
    await flag('api_disabled', 'true'); // The existing transport kills only on exact '1'.
    expect((await auth!.authenticate(request(peer.key), opts)).id).toBe(peer.id);
    await flag('reverse_dns_enabled', '1');
    vi.mocked(assertReverseDnsMatch).mockRejectedValue(new Error('DNS failure'));
    await expect(auth!.authenticate(request(peer.key), opts)).rejects.toMatchObject({
      code: 'reverse_dns_failed',
    });
    await handle!.db.update(hosts).set({ reverseDnsMode: 0 }).where(eq(hosts.id, peer.id));
    expect((await auth!.authenticate(request(peer.key), opts)).id).toBe(peer.id);
    await handle!.db.update(hosts).set({ reverseDnsMode: 1 }).where(eq(hosts.id, peer.id));
    await flag('reverse_dns_enabled', '0');
    await expect(auth!.authenticate(request(peer.key), opts)).rejects.toMatchObject({
      code: 'reverse_dns_failed',
    });
  });

  it('uses the policy from the admission snapshot while the next request sees a concurrent change', async () => {
    const peer = await seed();
    const original = handle!.pool.query.bind(handle!.pool);
    const query = vi.spyOn(handle!.pool, 'query').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await flag('reverse_dns_enabled', '1');
      return result;
    });
    vi.mocked(assertReverseDnsMatch).mockRejectedValue(new Error('DNS failure'));
    try {
      expect((await auth!.authenticate(request(peer.key), opts)).id).toBe(peer.id);
      expect(assertReverseDnsMatch).not.toHaveBeenCalled();
      await expect(auth!.authenticate(request(peer.key), opts)).rejects.toMatchObject({
        code: 'reverse_dns_failed',
      });
    } finally {
      query.mockRestore();
    }
  });

  it('keeps temporary expiry and locked checkpoint revalidation', async () => {
    const expired = await seed({ expiresAt: '2000-01-01T00:00:00Z' });
    await expect(auth!.authenticate(request(expired.key), opts)).rejects.toMatchObject({
      code: 'host_expired',
    });
    const peer = await seed({ lastContactAt: '2000-01-01T00:00:00Z' });
    const transaction = handle!.db.transaction.bind(handle!.db);
    const tx = vi.spyOn(handle!.db, 'transaction').mockImplementationOnce(async (...args) => {
      await handle!.db
        .update(hosts)
        .set({ apiKey: 'rotated', apiKeyHash: hashApiKey('rotated') })
        .where(eq(hosts.id, peer.id));
      return transaction(...args);
    });
    try {
      await expect(auth!.authenticate(request(peer.key), opts)).rejects.toMatchObject({
        code: 'invalid_api_key',
      });
    } finally {
      tx.mockRestore();
    }
  });

  it('rejects query failures instead of using a prior successful admission', async () => {
    const peer = await seed();
    await auth!.authenticate(request(peer.key), opts);
    const query = vi.spyOn(handle!.pool, 'query').mockRejectedValueOnce(new Error('admission read failed'));
    try {
      await expect(auth!.authenticate(request(peer.key), opts)).rejects.toThrow();
    } finally {
      query.mockRestore();
    }
    expect((await auth!.authenticate(request(peer.key), opts)).id).toBe(peer.id);
  });
});

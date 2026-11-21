import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import { adminEvents, hosts, logs, versions } from '../../../src/db/schema.js';
import { sha256 } from '../../../src/security/hash.js';
import { decrypt } from '../../../src/security/secret-box.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { HostManagementService } from '../../../src/services/host-management.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const fqdn = 'registered.example.test';
const oldKey = 'fixture-old-key';
const oldHash = sha256(oldKey);
const createdAt = '2020-01-01T00:00:00Z';

function existingHost(engines = 'codex,claude') {
  return { id: 7, fqdn, apiKey: oldHash, apiKeyHash: oldHash, apiKeyEnc: null,
    status: 'active', secure: 1, engines, createdAt, updatedAt: createdAt, lastContactAt: new Date().toISOString() };
}

function harness(rows: Record<string, unknown>[] = [], defaultEngines = 'codex') {
  const fake = createDbFake();
  fake.tables.set(hosts, rows);
  const db = fake as unknown as Database;
  const keyring = testKeyring();
  const service = new HostManagementService({
    db, keyring, env: { ...loadTestEnv(), DEFAULT_HOST_ENGINES: defaultEngines },
    events: makeAdminEventsWriter(db),
  });
  return { fake, service, keyring };
}

afterEach(() => vi.restoreAllMocks());

describe('registration through the admin host service', () => {
  it.each([false, true])('stores key hashes and a decryptable envelope, then audits and publishes (rotation: %s)', async rotation => {
    const { fake, service, keyring } = harness(rotation ? [existingHost()] : []);
    const publish = vi.spyOn(wsPublisher, 'publish');
    const { host, apiKeyPlain } = await service.register({ fqdn: '  ' + fqdn + '\n', engines: ['codex', 'claude'] });
    const hash = sha256(apiKeyPlain);
    expect(apiKeyPlain).not.toBe(oldKey);
    expect(hash).not.toBe(oldHash);
    const stored = fake.tables.get(hosts)!;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: host.id, fqdn, apiKey: hash, apiKeyHash: hash, engines: 'codex,claude', status: 'active' });
    expect(decrypt(String(stored[0]!.apiKeyEnc), keyring)).toBe(apiKeyPlain);
    if (rotation) {
      expect(host.id).toBe(7);
      expect(stored[0]!.createdAt).toBe(createdAt);
      expect(stored[0]!.updatedAt).not.toBe(createdAt);
      expect(fake.inserts.filter(row => row.table === hosts)).toHaveLength(0);
    }
    const event = rotation ? 'host.updated' : 'host.created';
    expect(fake.tables.get(adminEvents)).toContainEqual(expect.objectContaining({
      type: event, hostId: host.id,
      payload: expect.objectContaining({ fqdn, secure: true, engines: 'codex,claude' }),
    }));
    expect(fake.tables.get(logs)).toContainEqual(expect.objectContaining({ hostId: host.id, action: 'register',
      details: JSON.stringify({ result: rotation ? 'rotated' : 'created', engines: 'codex,claude' }),
    }));
    expect(publish).toHaveBeenCalledWith(event, { id: host.id, fqdn });
  });

  it('rejects a newly disabled assignment against the row locked during rotation', async () => {
    const { fake, service } = harness([existingHost()]);
    fake.tables.set(versions, [{ name: 'codex_engine_disabled', version: '1' }]);
    const transaction = fake.transaction.bind(fake);
    vi.spyOn(fake, 'transaction').mockImplementationOnce(async callback => {
      fake.tables.set(hosts, [existingHost('claude')]);
      return transaction(callback);
    });
    await expect(service.register({ fqdn, engines: ['codex', 'claude'] })).rejects.toMatchObject({ code: 'engine_disabled' });
    expect(fake.tables.get(hosts)?.[0]).toMatchObject({ engines: 'claude', apiKeyHash: oldHash });
  });

  it('rejects an unavailable default before writing credentials and removes disabled engines from mixed defaults', async () => {
    const blocked = harness();
    blocked.fake.tables.set(versions, [{ name: 'codex_engine_disabled', version: '1' }]);
    await expect(blocked.service.register({ fqdn })).rejects.toMatchObject({ code: 'engine_disabled', status: 409 });
    expect(blocked.fake.tables.get(hosts)).toEqual([]);
    const mixed = harness([], 'codex,claude');
    mixed.fake.tables.set(versions, [{ name: 'codex_engine_disabled', version: '1' }]);
    expect((await mixed.service.register({ fqdn })).host.engines).toBe('claude');
  });

  it('preserves a suspended assignment when omitted and replaces it on an explicit engine change', async () => {
    const { service, fake } = harness([existingHost()]);
    fake.tables.set(versions, [{ name: 'codex_engine_disabled', version: '1' }]);
    expect((await service.register({ fqdn })).host.engines).toBe('codex,claude');
    expect((await service.register({ fqdn, engines: ['claude'] })).host.engines).toBe('claude');
    expect(fake.tables.get(hosts)?.[0]?.engines).toBe('claude');
  });

  it.each([false, true])('opens the requested initial or rotated insecure window (rotation: %s)', async rotation => {
    const { service } = harness(rotation ? [existingHost()] : []);
    const before = Date.now();
    const { host } = await service.register({ fqdn, secure: false, duration_minutes: 45 });
    const deadline = new Date(host.insecureEnabledUntil!).getTime();
    expect(host.secure).toBe(0);
    expect(deadline).toBeGreaterThanOrEqual(before + 45 * 60_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 45 * 60_000);
    expect((await service.findById(host.id))!.insecureEnabledUntil).toEqual(host.insecureEnabledUntil);
  });

  it('keeps the default secure host outside the insecure window', async () => {
    const { service } = harness();
    const { host } = await service.register({ fqdn });
    expect(host.secure).toBe(1);
    expect(host.insecureEnabledUntil ?? null).toBeNull();
  });
});

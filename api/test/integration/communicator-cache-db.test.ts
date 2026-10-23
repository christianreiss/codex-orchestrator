import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { createDb } from '../../src/db/client.js';
import { authoritativeReads, authoritativeSnapshot } from '../../src/db/fresh-read.js';
import { versions, hosts, clientConfigDocuments } from '../../src/db/schema.js';
import { readDbConfig } from '../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';
import { buildHostApiTestApp } from '../helpers/build-host-api-app.js';
import { registerProjectsClientRoutes } from '../../src/routes/projects-client/index.js';
import { hashApiKey } from '../../src/util/api-key-helpers.js';
import { randomUUID, createHash } from 'node:crypto';

const config = readDbConfig();
describe.skipIf(!config)('communicator authoritative snapshots against MySQL', () => {
  let handle: ReturnType<typeof createDb>;
  let outside: mysql.Connection;
  const name = `ztest-cache-${randomUUID()}`;
  const read = async () =>
    (await handle.db.select().from(versions).where(eq(versions.name, name)))[0]?.version;
  beforeAll(async () => {
    const cfg = config!;
    const env = {
      ...loadTestEnv(),
      DB_HOST: String(cfg.host),
      DB_PORT: Number(cfg.port ?? 3306),
      DB_USERNAME: String(cfg.user),
      DB_PASSWORD: String(cfg.password ?? ''),
      DB_DATABASE: String(cfg.database),
      DB_READ_CACHE_RESYNC_SECONDS: 3600,
    };
    handle = createDb(env, { readCache: true });
    outside = await mysql.createConnection(cfg);
    await handle.db.insert(versions).values({ name, version: 'before', updatedAt: new Date().toISOString() });
  });
  afterAll(async () => {
    if (handle) {
      await handle.db.delete(versions).where(eq(versions.name, name));
      await handle.pool.end();
    }
    await outside?.end();
  });

  it('bypasses a warm stale read cache and keeps one coherent snapshot across an external commit', async () => {
    expect(await read()).toBe('before');
    await outside.execute('UPDATE versions SET version = ? WHERE name = ?', ['external', name]);
    expect(await read()).toBe('before');
    expect(await authoritativeReads(read)).toBe('external');
    await authoritativeSnapshot(handle.db, async () => {
      expect(await read()).toBe('external');
      await outside.execute('UPDATE versions SET version = ? WHERE name = ?', ['after-snapshot', name]);
      expect(await read()).toBe('external');
    });
    expect(await authoritativeSnapshot(handle.db, read)).toBe('after-snapshot');
  });

  it('runs the real config renderer and rejects a revoked host despite a warm manifest', async () => {
    const apiKey = `cache-test-${randomUUID()}`;
    const stamp = new Date().toISOString();
    const [host] = await handle.db
      .insert(hosts)
      .values({
        fqdn: `${randomUUID()}.example`,
        apiKey,
        apiKeyHash: hashApiKey(apiKey),
        secure: 1,
        allowRoamingIps: 1,
        reverseDnsMode: 0,
        engines: 'codex',
        createdAt: stamp,
        updatedAt: stamp,
      })
      .$returningId();
    const body = 'model = "cache-test"\n';
    const [doc] = await handle.db
      .insert(clientConfigDocuments)
      .values({
        engine: 'codex',
        body,
        sha256: createHash('sha256').update(body).digest('hex'),
        createdAt: stamp,
        updatedAt: stamp,
      })
      .$returningId();
    const env = {
      ...loadTestEnv(),
      CXX_COMMUNICATOR_ENABLED: true,
      CXX_COMMUNICATOR_SYNC_ENABLED: true,
      PUBLIC_BASE_URL: 'https://cache.example',
    };
    const app = await buildHostApiTestApp({ db: handle.db, env, keyring: testKeyring() });
    await registerProjectsClientRoutes(app, { db: handle.db, env, keyring: testKeyring() });
    const input = {
      protocol: 2,
      request_id: randomUUID(),
      method: 'POST',
      path: '/config/retrieve',
      body: { engine: 'codex' },
      headers: {},
      known: {},
    };
    const readConfig = () =>
      app.inject({ method: 'POST', url: '/sync/cache', headers: { 'x-api-key': apiKey }, payload: input });
    try {
      const first = await readConfig();
      expect(first.statusCode, first.payload).toBe(200);
      const resources = first.json().data.resources;
      expect(resources.length).toBeGreaterThan(0);
      input.known = Object.fromEntries(
        resources.map((r: { path: string[]; revision: string }) => [JSON.stringify(r.path), r.revision]),
      );
      input.request_id = randomUUID();
      const second = await readConfig();
      expect(second.statusCode, second.payload).toBe(200);
      expect(second.json().data.resources.every((r: object) => !('content' in r))).toBe(true);
      await outside.execute('UPDATE hosts SET status = ? WHERE id = ?', ['disabled', host!.id]);
      input.request_id = randomUUID();
      const refused = await readConfig();
      expect(refused.statusCode, refused.payload).toBe(403);
    } finally {
      await app.close();
      await handle.db.delete(clientConfigDocuments).where(eq(clientConfigDocuments.id, doc!.id));
      await handle.db.delete(hosts).where(eq(hosts.id, host!.id));
    }
  });
});

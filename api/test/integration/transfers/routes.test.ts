/**
 * Route-level guards and wire shape for the file transfer admin API.
 *
 * The claim under test is that the three capabilities are actually three. The
 * pool holds whatever agents chose to upload, so reading a file back is a
 * different grant from seeing that it exists and from switching the module off
 * — the same line `secrets.reveal` draws. A `fleet_operator` may empty the pool
 * and must not be able to read what was in it; a `viewer` may look at the
 * listing and must be refused everything else. Those are matrix claims, so this
 * runs against the shipped capability plugin rather than a copy of the table.
 */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerAdminTransfersRoutes } from '../../../src/routes/admin/transfers/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { agentTransferEvents, agentTransfers, versions } from '../../../src/db/schema.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';

const apps: Array<ReturnType<typeof Fastify>> = [];
let dataRoot: string;

const LIVE_ID = '11111111-1111-4111-8111-111111111111';
const CONTENT = 'artifact bytes';

function seedDb(): DbFake {
  const db = createDbFake();
  db.tables.set(agentTransfers, [
    {
      id: LIVE_ID,
      name: 'build.tar.gz',
      description: null,
      mimeType: 'application/gzip',
      sizeBytes: CONTENT.length,
      contentSha256: 'a'.repeat(64),
      storagePath: join('transfers', LIVE_ID.slice(0, 2), LIVE_ID),
      status: 'live',
      sourceHostId: 3,
      uploadedBy: 'chris',
      uploadedFrom: '/repo',
      requestedTtlSeconds: 600,
      downloadCount: 0,
      // Far enough out that the read-sweep never fires mid-test.
      expiresAt: '2099-01-01T00:00:00Z',
      sealedAt: '2026-09-09T09:00:00Z',
      purgedAt: null,
      createdAt: '2026-09-09T09:00:00Z',
      updatedAt: '2026-09-09T09:00:00Z',
    },
  ]);
  db.tables.set(agentTransferEvents, []);
  db.tables.set(versions, [
    { name: 'transfers_module_enabled', version: '1', updatedAt: '2026-09-09T09:00:00Z' },
  ]);
  return db;
}

async function buildApp(role: string | null, db: DbFake = seedDb()) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  await registerCapabilityStack(app, { role });
  await registerAdminTransfersRoutes(app, {
    db: db as never,
    env: { DATA_ROOT: dataRoot } as never,
    keyring: {} as never,
  } as RouteContext);
  return app;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'transfers-routes-'));
  await mkdir(join(dataRoot, 'transfers', LIVE_ID.slice(0, 2)), { recursive: true });
  await writeFile(join(dataRoot, 'transfers', LIVE_ID.slice(0, 2), LIVE_ID), CONTENT);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await rm(dataRoot, { recursive: true, force: true });
});

describe('capability separation', () => {
  it('lets a viewer see that a file exists', async () => {
    const app = await buildApp('viewer');
    const res = await app.inject({ method: 'GET', url: '/admin/transfers' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.transfers).toHaveLength(1);
  });

  it('refuses a viewer the bytes, the switch, and the delete', async () => {
    const app = await buildApp('viewer');
    for (const call of [
      { method: 'GET' as const, url: `/admin/transfers/${LIVE_ID}/content` },
      { method: 'POST' as const, url: '/admin/transfers/state', payload: { enabled: false } },
      { method: 'POST' as const, url: '/admin/transfers/limits', payload: { max_ttl_seconds: 600 } },
      { method: 'DELETE' as const, url: `/admin/transfers/${LIVE_ID}` },
    ]) {
      const res = await app.inject(call);
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
    }
  });

  it('lets a fleet operator run the pool but never read what is in it', async () => {
    const app = await buildApp('fleet_operator');
    // Keeping the module running is fleet operation…
    expect((await app.inject({ method: 'GET', url: '/admin/transfers/state' })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/transfers/state',
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(200);
    // …reading an agent's payload back is not.
    expect(
      (await app.inject({ method: 'GET', url: `/admin/transfers/${LIVE_ID}/content` })).statusCode,
    ).toBe(403);
  });

  it('gives an admin the bytes', async () => {
    const app = await buildApp('admin');
    const res = await app.inject({ method: 'GET', url: `/admin/transfers/${LIVE_ID}/content` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(CONTENT);
  });

  it('refuses an anonymous caller everything', async () => {
    const app = await buildApp(null);
    const res = await app.inject({ method: 'GET', url: '/admin/transfers' });
    expect(res.statusCode).toBe(401);
  });
});

describe('download response', () => {
  it('sends the file rather than the JSON envelope, named for its uploader', async () => {
    const app = await buildApp('admin');
    const res = await app.inject({ method: 'GET', url: `/admin/transfers/${LIVE_ID}/content` });

    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.headers['content-length']).toBe(String(CONTENT.length));
    // Both spellings: the ASCII fallback every browser accepts, and the RFC 5987
    // form that survives a name the fallback cannot spell.
    expect(res.headers['content-disposition']).toContain('attachment; filename="build.tar.gz"');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''build.tar.gz");
    // A browser must not be able to sniff an agent-supplied payload into script.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe(CONTENT);
  });

  it('records the fetch, which is what the absence of addressing owes an operator', async () => {
    const db = seedDb();
    const app = await buildApp('admin', db);
    await app.inject({ method: 'GET', url: `/admin/transfers/${LIVE_ID}/content` });

    const recorded = db.inserts
      .filter((entry) => entry.table === agentTransferEvents)
      .flatMap((entry) => (Array.isArray(entry.values) ? entry.values : [entry.values]));
    const download = recorded.find((row) => row['action'] === 'downloaded');
    expect(download).toBeTruthy();
    expect(download?.['actorKind']).toBe('admin');
  });
});

describe('request validation', () => {
  it('accepts every spelling of the toggle the console might send', async () => {
    const app = await buildApp('admin');
    for (const enabled of [true, false, 1, 0, '1', '0', 'true', 'false']) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/transfers/state',
        payload: { enabled },
      });
      expect(res.statusCode, JSON.stringify(enabled)).toBe(200);
    }
  });

  it('rejects a body with no enabled field', async () => {
    const app = await buildApp('admin');
    const res = await app.inject({ method: 'POST', url: '/admin/transfers/state', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown limits field rather than silently dropping it', async () => {
    // `.strict()` is load-bearing: without it a typo in a limit name would 200
    // while changing nothing, which is the worst possible answer.
    const app = await buildApp('admin');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/transfers/limits',
      payload: { max_ttl_secondss: 600 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an incoherent limits set at the service boundary', async () => {
    // 422 rather than the schema's 400: the shape is valid and the values are
    // not, which is the distinction ValidationError draws across this codebase.
    const app = await buildApp('admin');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/transfers/limits',
      payload: { default_ttl_seconds: 90_000 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/default_ttl_seconds/);
  });
});

describe('listing shape', () => {
  it('carries the asserted uploader and the deadline, and never a path on disk', async () => {
    const app = await buildApp('admin');
    const row = (await app.inject({ method: 'GET', url: '/admin/transfers' })).json().data
      .transfers[0];

    expect(row.uploaded_by).toBe('chris');
    expect(row.expires_at).toBe('2099-01-01T00:00:00Z');
    // The storage path is an internal detail; publishing it would invite
    // someone to reason about the volume layout from the console.
    expect(Object.keys(row)).not.toContain('storage_path');
    expect(Object.keys(row).sort()).toEqual([
      'content_sha256',
      'created_at',
      'description',
      'download_count',
      'expires_at',
      'id',
      'mime_type',
      'name',
      'requested_ttl_seconds',
      'sealed_at',
      'size_bytes',
      'source_host_id',
      'status',
      'ttl_clamped',
      'updated_at',
      'uploaded_by',
      'uploaded_from',
    ]);
  });

  it('answers a missing transfer with 404 rather than 500', async () => {
    const app = await buildApp('admin');
    const res = await app.inject({ method: 'GET', url: '/admin/transfers/nope/content' });
    expect(res.statusCode).toBe(404);
  });
});

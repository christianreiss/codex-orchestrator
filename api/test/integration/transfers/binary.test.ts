import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { registerTransfersRoutes } from '../../../src/routes/transfers/index.js';
import { UnauthorizedError } from '../../../src/http/errors.js';
import {
  agentTransfers,
  agentTransferEvents,
  clientConfigDocuments,
  versions,
} from '../../../src/db/schema.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { createTransferDb, createTransferSettings } from '../../helpers/transfer-store.js';
import { getTestDb } from '../../helpers/test-db.js';
import { eq } from 'drizzle-orm';
import { AgentTransfersService } from '../../../src/services/agent-transfers.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';

// Host authentication/IP policy has its own suites. This boundary fixture gives
// two distinct authenticated hosts to the real route/service/storage stack.
vi.mock('../../../src/services/host-auth.js', () => ({
  createHostAuthService: () => ({
    authenticate: async (req: { headers: Record<string, string> }) => {
      const key = req.headers['x-api-key'];
      if (key !== 'sender' && key !== 'receiver') throw new UnauthorizedError('Invalid host credential');
      return { id: key === 'sender' ? 7 : 8, secure: 1, engines: 'codex,claude,grok' };
    },
  }),
}));

const handle = await getTestDb();

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createTransferDb>;
let dataRoot: string;
const metadata = (data: Buffer) => ({
  id: randomUUID(),
  name: 'binary.dat',
  size_bytes: data.length,
  content_sha256: createHash('sha256').update(data).digest('hex'),
  ttl_seconds: 3600,
});
const url = (path = '', engine = 'codex') =>
  `/host/transfers${path}${path.includes('?') ? '&' : '?'}engine=${engine}`;
const headers = { 'x-api-key': 'sender' };
const json = (res: { json: () => { data: unknown } }) =>
  res.json().data as { transfer: { id: string; size_bytes: number; status: string } };

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'binary-routes-'));
  db = createTransferDb();
  db.rows.set(versions, [{ name: 'transfers_module_enabled', version: '1' }]);
  db.rows.set(
    clientConfigDocuments,
    ['codex', 'claude', 'grok'].map((engine, id) => ({ id, engine, settings: {} })),
  );
  app = Fastify({ bodyLimit: 32 * 1024 * 1024 });
  await app.register(envelopePlugin);
  await registerTransfersRoutes(app, { db, env: { DATA_ROOT: dataRoot } } as unknown as RouteContext);
});
afterEach(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
});

it.each(['codex', 'claude', 'grok'])(
  'streams arbitrary bytes and resumable ranges for %s',
  async (engine) => {
    const data = Buffer.from([0, 255, 128, 13, 10, 0, 7]);
    const m = metadata(data);
    expect((await app.inject({ method: 'POST', url: url('', engine), headers, payload: m })).statusCode).toBe(
      200,
    );
    const chunk = await app.inject({
      method: 'PUT',
      url: url(`/${m.id}/content?offset=0`, engine),
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: data,
    });
    expect(chunk.statusCode, chunk.body).toBe(200);
    expect(json(chunk).transfer.size_bytes).toBe(data.length);
    expect(
      (await app.inject({ method: 'POST', url: url(`/${m.id}/complete`, engine), headers })).statusCode,
    ).toBe(200);
    const get = await app.inject({
      method: 'GET',
      url: url(`/${m.id}/content`, engine),
      headers: { 'x-api-key': 'receiver', range: 'bytes=2-' },
    });
    expect(get.statusCode, get.body).toBe(206);
    expect(get.headers['content-range']).toBe(`bytes 2-6/7`);
    expect(get.headers.etag).toBe(`"${m.content_sha256}"`);
    expect(get.rawPayload).toEqual(data.subarray(2));
    expect(
      (
        await app.inject({
          method: 'GET',
          url: url(`/${m.id}/content`, engine),
          headers: { ...headers, range: 'bytes=99-' },
        })
      ).statusCode,
    ).toBe(416);
  },
);

it('authenticates before body parsing and enforces module/config/engine controls', async () => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: url(),
        payload: 'invalid JSON',
        headers: { 'content-type': 'application/json' },
      })
    ).statusCode,
  ).toBe(401);
  const m = metadata(Buffer.from('x'));
  const state = db.rows.get(versions)!;
  state[0]!['version'] = '0';
  expect((await app.inject({ method: 'POST', url: url(), headers, payload: m })).statusCode).toBe(403);
  state[0]!['version'] = '1';
  state.push({ name: 'grok_engine_disabled', version: '1' });
  invalidateFleetEngineState(db);
  expect((await app.inject({ method: 'POST', url: url('', 'grok'), headers, payload: m })).statusCode).toBe(
    403,
  );
  db.rows.set(clientConfigDocuments, []);
  expect((await app.inject({ method: 'POST', url: url(), headers, payload: m })).statusCode).toBe(403);
  db.rows.set(clientConfigDocuments, [
    { id: 1, engine: 'codex', settings: { orchestrator_mcp_enabled: false } },
  ]);
  expect((await app.inject({ method: 'POST', url: url(), headers, payload: m })).statusCode).toBe(403);
});

it('refuses another host continuing or sealing an upload', async () => {
  const m = metadata(Buffer.from('a'));
  await app.inject({ method: 'POST', url: url(), headers, payload: m });
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: url(`/${m.id}/content?offset=0`),
        headers: { 'x-api-key': 'receiver', 'content-type': 'application/octet-stream' },
        payload: 'a',
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: url(`/${m.id}/complete`),
        headers: { 'x-api-key': 'receiver' },
      })
    ).statusCode,
  ).toBe(403);
});

// Opt-in exercises the Go client against these real Fastify routes, actual TCP,
// actual disk and MySQL. It requires a disposable database provisioned by the
// repository migration fixture, never an ambient production connection.
describe.skipIf(!handle)('Go / HTTP / MySQL acceptance', () => {
  it.skipIf(process.env.TEST_BINARY_TRANSFER_LARGE !== '1')(
    'transfers multiple GiB with bounded process memory',
    async () => {
      const real = handle!;
      await app.close();
      const before = new Set((await real.db.select().from(agentTransfers)).map((r) => r.id));
      const inserted = await real.db
        .insert(clientConfigDocuments)
        .values({
          sha256: '0'.repeat(64),
          body: '',
          settings: {},
          engine: 'codex',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      const configId = Number(inserted[0].insertId);
      const originalFlag = await real.db
        .select()
        .from(versions)
        .where(eq(versions.name, 'transfers_module_enabled'));
      await real.db
        .insert(versions)
        .values({ name: 'transfers_module_enabled', version: '1', updatedAt: new Date().toISOString() })
        .onDuplicateKeyUpdate({ set: { version: '1' } });
      app = Fastify({ bodyLimit: 32 * 1024 * 1024 });
      await app.register(envelopePlugin);
      await registerTransfersRoutes(app, {
        db: real!.db,
        env: { DATA_ROOT: dataRoot },
      } as unknown as RouteContext);
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const baseline = process.memoryUsage().rss;
      let peak = baseline;
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 50);
      try {
        const result = await promisify(execFile)(
          'go',
          ['test', './internal/transfers', '-run', 'TestFleetHTTPAcceptance', '-v', '-count=1'],
          {
            cwd: resolve('../wrappers/cxx'),
            env: { ...process.env, CXX_TRANSFER_TEST_URL: address },
            timeout: 180000,
            maxBuffer: 1 << 20,
          },
        );
        process.stdout.write(result.stdout);
        process.stdout.write(
          `API RSS: baseline ${(baseline / 1048576).toFixed(1)} MiB, peak ${(peak / 1048576).toFixed(1)} MiB\n`,
        );
        expect(peak - baseline).toBeLessThan(256 * 1048576);
      } finally {
        clearInterval(sampler);
        const rows = await real!.db.select().from(agentTransfers);
        for (const row of rows.filter((r) => !before.has(r.id))) {
          await real!.db.delete(agentTransferEvents).where(eq(agentTransferEvents.transferId, row.id));
          await real!.db.delete(agentTransfers).where(eq(agentTransfers.id, row.id));
        }
        await real.db.delete(clientConfigDocuments).where(eq(clientConfigDocuments.id, configId));
        if (originalFlag[0])
          await real.db
            .update(versions)
            .set({ version: originalFlag[0].version })
            .where(eq(versions.name, 'transfers_module_enabled'));
        else await real.db.delete(versions).where(eq(versions.name, 'transfers_module_enabled'));
      }
    },
    200000,
  );

  it('serializes quota reservations and overlapping commits across MySQL connections', async () => {
    const real = handle!;
    const settings = createTransferSettings({ transfers_quota_bytes: '10' });
    const first = new AgentTransfersService({ db: real.db, settings, dataRoot });
    const second = new AgentTransfersService({ db: real.db, settings, dataRoot });
    const bytes = Buffer.from('abcdef');
    const inputs = [metadata(bytes), metadata(bytes)];
    const host = { id: 7 } as import('../../../src/db/schema.js').Host;
    try {
      const created = await Promise.allSettled([
        first.createBinary(inputs[0]!, host),
        second.createBinary(inputs[1]!, host),
      ]);
      expect(created.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const success = created.find((r) => r.status === 'fulfilled');
      if (success?.status !== 'fulfilled') throw new Error('no successful reservation');
      const id = success.value.id;
      const writers = await Promise.allSettled(
        [first, second].map((service) =>
          service.appendBinary(
            id,
            0,
            bytes.length,
            (async function* () {
              yield bytes;
            })(),
            host,
          ),
        ),
      );
      expect(writers.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await first.sealBinary(id, host)).size_bytes).toBe(bytes.length);
    } finally {
      for (const input of inputs) {
        await real.db.delete(agentTransferEvents).where(eq(agentTransferEvents.transferId, input.id));
        await real.db.delete(agentTransfers).where(eq(agentTransfers.id, input.id));
      }
    }
  });
});

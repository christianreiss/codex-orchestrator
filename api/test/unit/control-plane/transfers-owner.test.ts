import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import type { Database } from '../../../src/db/client.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { SettingsService } from '../../../src/services/settings.js';
import { AgentTransfersService } from '../../../src/services/agent-transfers.js';
const queues: DeadlineQueue[] = [],
  dirs: string[] = [];
afterEach(async () => {
  queues.splice(0).forEach((q) => q.close());
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function harness(rows: Record<string, Record<string, unknown>[]> = {}) {
  const now = new Date().toISOString();
  const seed = {
    providerAccounts: [
      {
        id: 1,
        engine: 'codex',
        state: 'enabled',
        payloadId: 1,
        lastSelectedAt: null,
        mergedIntoAccountId: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    authPayloads: [{ id: 1, engine: 'codex', accountId: 1, verificationState: 'verified' }],
    ...rows,
  };
  const db = createDbFake(
    new Map(
      Object.entries(seed).map(([name, values]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone(values),
      ]),
    ),
  );
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
  );
  const deadlines = new DeadlineQueue((e) => {
    throw e;
  });
  queues.push(deadlines);
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(e) {
      throw e;
    },
    committed() {},
    notificationError(e) {
      throw e;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(db as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const owner: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  const select = vi.spyOn(db, 'select');
  bindOwnerRuntime(db, owner);
  return { owner, state, db, select };
}

async function fixture() {
  const h = harness(),
    dir = await mkdtemp(join(tmpdir(), 'owned-transfer-'));
  dirs.push(dir);
  const db = h.db as unknown as Database;
  return {
    ...h,
    dir,
    service: new AgentTransfersService({ db, settings: new SettingsService(db), dataRoot: dir }),
  };
}
const host = { id: 1 } as schema.Host;
describe('owned transfer lifecycle', () => {
  it('serializes competing offsets and recovers an uncommitted file tail with RAM metadata', async () => {
    const h = await fixture(),
      created = await h.service.put(
        { name: 'test', content_b64: Buffer.from('AAAA').toString('base64'), ttl_seconds: 600, final: false },
        host,
      ),
      id = created.transfer.id,
      path = join(h.dir, 'transfers', id.slice(0, 2), id);
    await appendFile(path, 'uncommitted tail');
    const result = await Promise.allSettled(
      ['BBBB', 'CCCC'].map((content) =>
        h.service.put(
          { id, offset: 4, content_b64: Buffer.from(content).toString('base64'), final: false },
          host,
        ),
      ),
    );
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await readFile(path)).length).toBe(8);
    expect(h.state.snapshot().table('agentTransfers').get(id)?.sizeBytes).toBe(8);
    await h.service.info(id);
    await h.service.list();
    await h.service.discovery();
    expect(h.select).not.toHaveBeenCalled();
    await h.service.remove(id, { kind: 'agent', hostId: 1, label: null });
    expect(h.state.snapshot().table('agentTransfers').get(id)?.status).toBe('deleted');
    await expect(readFile(path)).rejects.toThrow();
  });
  it('keeps an admitted download readable after retirement unlinks its path', async () => {
    const h = await fixture(),
      bytes = Buffer.from('open before unlink');
    const uploaded = await h.service.put(
      { name: 'open', content_b64: bytes.toString('base64'), ttl_seconds: 600 },
      host,
    );
    const download = await h.service.openDownload(uploaded.transfer.id, {
      kind: 'agent',
      hostId: 1,
      label: null,
    });
    await h.service.remove(uploaded.transfer.id, { kind: 'agent', hostId: 1, label: null });
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });
  it('closes an admitted descriptor when the response is abandoned', async () => {
    const h = await fixture();
    const uploaded = await h.service.put(
      { name: 'abort', content_b64: Buffer.from('data').toString('base64'), ttl_seconds: 600 },
      host,
    );
    const download = await h.service.openDownload(uploaded.transfer.id, {
      kind: 'agent',
      hostId: 1,
      label: null,
    });
    const closed = once(download.stream, 'close');
    download.stream.destroy();
    await closed;
    expect(download.stream.closed).toBe(true);
  });
  it('creates, appends, seals and downloads binary content with exact retry identity', async () => {
    const h = await fixture(),
      id = randomUUID(),
      bytes = Buffer.from('binary payload'),
      input = {
        id,
        name: 'binary',
        size_bytes: bytes.length,
        content_sha256: createHash('sha256').update(bytes).digest('hex'),
        ttl_seconds: 600,
      };
    await h.service.createBinary(input, host);
    await h.service.createBinary(input, host);
    expect(h.state.snapshot().table('agentTransfers').all()).toHaveLength(1);
    await h.service.appendBinary(id, 0, bytes.length, Readable.from([bytes]), host);
    await h.service.sealBinary(id, host);
    expect((await h.service.sealBinary(id, host)).status).toBe('live');
    const download = await h.service.openBinaryDownload(id, 0, { kind: 'agent', hostId: 1, label: null }),
      parts: Buffer[] = [];
    for await (const part of download.stream) parts.push(Buffer.from(part));
    await download.completed();
    expect(Buffer.concat(parts)).toEqual(bytes);
    expect(h.state.snapshot().table('agentTransfers').get(id)?.downloadCount).toBe(1);
    expect(h.select).not.toHaveBeenCalled();
  });
  it('commits retirement before unlink and retries pending cleanup after a failure', async () => {
    const h = await fixture(),
      created = await h.service.put(
        { name: 'retire', content_b64: Buffer.from('data').toString('base64'), ttl_seconds: 600 },
        host,
      ),
      id = created.transfer.id,
      path = join(h.dir, 'transfers', id.slice(0, 2), id);
    let sawRetiredBeforeUnlink = false;
    const stop = h.state.subscribe((snapshot) => {
      const row = snapshot.table('agentTransfers').get(id);
      if (row?.status === 'deleted' && !row.purgedAt) {
        sawRetiredBeforeUnlink = existsSync(path);
      }
    });
    const failed = vi
      .spyOn(h.service as unknown as { unlink: (row: unknown) => Promise<void> }, 'unlink')
      .mockRejectedValueOnce(new Error('temporary filesystem failure'));
    await expect(h.service.remove(id, { kind: 'agent', hostId: 1, label: null })).rejects.toThrow(
      'temporary filesystem failure',
    );
    expect(sawRetiredBeforeUnlink).toBe(true);
    expect(h.state.snapshot().table('agentTransfers').get(id)).toMatchObject({
      status: 'deleted',
      purgedAt: null,
    });
    await expect(h.service.get(id)).rejects.toThrow();
    failed.mockRestore();
    stop();
    await h.service.sweepExpired();
    expect(existsSync(path)).toBe(false);
    expect(h.state.snapshot().table('agentTransfers').get(id)?.purgedAt).not.toBeNull();
  });
  it('writes a MCP download audit and completed count in one command', async () => {
    const h = await fixture(),
      created = await h.service.put(
        { name: 'one', content_b64: Buffer.from('data').toString('base64'), ttl_seconds: 600 },
        host,
      ),
      before = h.state.revision().sequence;
    const download = await h.service.get(created.transfer.id);
    expect(Buffer.from(download.content_b64, 'base64').toString()).toBe('data');
    expect(h.state.revision().sequence).toBe(before + 1n);
    expect(h.select).not.toHaveBeenCalled();
  });
});

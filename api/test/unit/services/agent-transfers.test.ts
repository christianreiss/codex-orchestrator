import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appendFile,
  open,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';

import {
  AgentTransfersService,
  clampTtlSeconds,
  normalizeTransferName,
  DEFAULT_MAX_TTL_SECONDS,
  HARD_MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  TRANSFERS_ENABLED_FLAG,
  TRANSFER_STATUS_DELETED,
  TRANSFER_STATUS_EXPIRED,
  TRANSFER_STATUS_LIVE,
  TRANSFER_STATUS_UPLOADING,
} from '../../../src/services/agent-transfers.js';
import { agentTransferEvents, agentTransfers, type Host } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';

/**
 * A behavioural fake, not the shared `db-fake`: that one only *records* updates,
 * and every interesting property of this service — a sweep flipping status, a
 * chunk growing size_bytes, a delete keeping the row — is about an update
 * actually landing.
 *
 * Predicates are matched by pulling the bound parameters out of the drizzle SQL
 * object and treating them as the set of ids to touch. That covers both shapes
 * the service uses (`eq(id, x)` and `inArray(id, [...])`) without teaching the
 * fake anything about SQL, and a predicate over some other column would simply
 * match nothing rather than silently matching everything.
 */
import {
  createTransferDb as createDb,
  createTransferSettings as createSettings,
} from '../../helpers/transfer-store.js';
type Row = Record<string, unknown>;

const HOST = { id: 7 } as Host;

let dataRoot: string;
let db: ReturnType<typeof createDb>;
let settings: ReturnType<typeof createSettings>;
let service: AgentTransfersService;

function transferRows(): Row[] {
  return db.rows.get(agentTransfers)!;
}

function eventRows(): Row[] {
  return db.rows.get(agentTransferEvents)!;
}

async function put(overrides: Record<string, unknown> = {}) {
  return await service.put(
    {
      name: 'build.tar.gz',
      content_b64: Buffer.from('hello world').toString('base64'),
      ttl_seconds: 600,
      ...overrides,
    },
    HOST,
  );
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'transfers-test-'));
  db = createDb();
  settings = createSettings({ [TRANSFERS_ENABLED_FLAG]: '1' });
  service = new AgentTransfersService({ db, settings, dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe('clampTtlSeconds', () => {
  it('leaves a request inside the band alone', () => {
    expect(clampTtlSeconds(600, DEFAULT_MAX_TTL_SECONDS)).toEqual({ effective: 600, clamped: false });
  });

  it('reports the clamp rather than silently shortening', () => {
    // The whole point: a file that vanished four hours early with no word of it
    // is indistinguishable from a bug.
    expect(clampTtlSeconds(999_999, DEFAULT_MAX_TTL_SECONDS)).toEqual({
      effective: DEFAULT_MAX_TTL_SECONDS,
      clamped: true,
    });
  });

  it('raises a too-short request to the floor', () => {
    // ttl_seconds: 0 would otherwise create a file the very next sweep removes.
    expect(clampTtlSeconds(0, DEFAULT_MAX_TTL_SECONDS)).toEqual({
      effective: MIN_TTL_SECONDS,
      clamped: true,
    });
  });

  it('never honours an operator maximum above the hard ceiling', () => {
    expect(clampTtlSeconds(HARD_MAX_TTL_SECONDS * 4, HARD_MAX_TTL_SECONDS * 2).effective).toBe(
      HARD_MAX_TTL_SECONDS,
    );
  });
});

describe('normalizeTransferName', () => {
  it('keeps a plain file name', () => {
    expect(normalizeTransferName('heap.hprof')).toBe('heap.hprof');
  });

  it('reduces a path to its last segment, so nothing traversal-shaped survives', () => {
    expect(normalizeTransferName('../../etc/passwd')).toBe('passwd');
    expect(normalizeTransferName('C:\\temp\\dump.bin')).toBe('dump.bin');
  });

  it('rejects a name that is only dots, quotes, or control characters', () => {
    expect(() => normalizeTransferName('..')).toThrow();
    expect(() => normalizeTransferName('a"b')).toThrow();
    expect(() => normalizeTransferName('a\nb')).toThrow();
    expect(() => normalizeTransferName('   ')).toThrow();
  });
});

describe('put', () => {
  it('writes the bytes to disk and seals the row in one call', async () => {
    const result = await put();
    expect(result.complete).toBe(true);
    expect(result.bytes_written).toBe(11);
    expect(result.transfer.status).toBe(TRANSFER_STATUS_LIVE);
    expect(result.transfer.content_sha256).toBe(createHash('sha256').update('hello world').digest('hex'));
    // Sharded by the first two characters of the id, not one flat directory.
    const shard = result.transfer.id.slice(0, 2);
    const info = await stat(join(dataRoot, 'transfers', shard, result.transfer.id));
    expect(info.size).toBe(11);
  });

  it('refuses an upload with no ttl_seconds, and says why', async () => {
    await expect(put({ ttl_seconds: undefined })).rejects.toThrow(/ttl_seconds is required/);
  });

  it('reports a clamped ttl on the result rather than hiding it', async () => {
    const result = await put({ ttl_seconds: 999_999 });
    expect(result.ttl_clamped).toBe(true);
    expect(result.transfer.requested_ttl_seconds).toBe(999_999);
    const granted = (Date.parse(result.transfer.expires_at) - Date.parse(result.transfer.created_at)) / 1000;
    expect(granted).toBeLessThanOrEqual(DEFAULT_MAX_TTL_SECONDS);
  });

  it('records the caller-asserted uploader beside the host it actually knows', async () => {
    const result = await put({ username: 'chris', worktree_path: '/repo' });
    expect(result.transfer.uploaded_by).toBe('chris');
    expect(result.transfer.uploaded_from).toBe('/repo');
    expect(result.transfer.source_host_id).toBe(7);
  });

  it('rejects a file over the per-file cap', async () => {
    settings.store.set('transfers_max_file_bytes', '4');
    await expect(put()).rejects.toThrow(/per-file limit/);
  });

  it('rejects an upload that would overrun the pool quota, naming the cap', async () => {
    settings.store.set('transfers_quota_bytes', '5');
    await expect(put()).rejects.toThrow(/pool is full/);
  });

  it('rejects content that is not valid base64 instead of storing corrupt bytes', async () => {
    await expect(put({ content_b64: 'not base64!!!' })).rejects.toThrow(/not valid base64/);
  });
});

describe('chunked put', () => {
  it('retries bytes from a failed metadata update without duplicating the chunk', async () => {
    const first = await put({ content_b64: Buffer.from('AAAA').toString('base64'), final: false });
    const id = first.transfer.id;
    const input = { id, content_b64: Buffer.from('BBBB').toString('base64'), offset: 4 };
    const update = vi.spyOn(db, 'update').mockImplementationOnce(
      () =>
        ({
          set: () => ({ where: () => Promise.reject(new Error('database connection lost')) }),
        }) as unknown as ReturnType<Database['update']>,
    );
    await expect(service.put(input, HOST)).rejects.toThrow('database connection lost');
    update.mockRestore();
    expect((await service.info(id)).size_bytes).toBe(4);
    expect(await readFile(join(dataRoot, 'transfers', id.slice(0, 2), id), 'utf8')).toBe('AAAABBBB');

    const restarted = new AgentTransfersService({ db, settings, dataRoot });
    const retried = await restarted.put(input, HOST);
    expect(retried.transfer.size_bytes).toBe(8);
    expect(Buffer.from((await restarted.get(id)).content_b64, 'base64').toString()).toBe('AAAABBBB');
    expect(retried.transfer.content_sha256).toBe(createHash('sha256').update('AAAABBBB').digest('hex'));
  });

  it.each([true, false])('discards an uncommitted tail before retrying (final=%s)', async (final) => {
    const first = await put({ content_b64: Buffer.from('AAAA').toString('base64'), final: false });
    const id = first.transfer.id;
    const path = join(dataRoot, 'transfers', id.slice(0, 2), id);
    // Model a process killed after a longer chunk reached disk, before the row commit.
    await appendFile(path, 'uncommitted bytes from a killed writer');
    const restarted = new AgentTransfersService({ db, settings, dataRoot });
    const result = await restarted.put(
      { id, content_b64: Buffer.from('BBBB').toString('base64'), offset: 4, final },
      HOST,
    );
    expect(result.transfer.size_bytes).toBe(8);
    expect(await readFile(path, 'utf8')).toBe('AAAABBBB');
    if (final) {
      const fetched = await restarted.get(id);
      const content = Buffer.from(fetched.content_b64, 'base64');
      expect(content.toString()).toBe('AAAABBBB');
      expect(fetched.transfer.content_sha256).toBe(createHash('sha256').update(content).digest('hex'));
    }
  });

  it('accepts only one overlapping retry at the same committed offset', async () => {
    const first = await put({ content_b64: Buffer.from('AAAA').toString('base64'), final: false });
    const id = first.transfer.id;
    const otherWorker = new AgentTransfersService({ db, settings, dataRoot });
    const input = { id, content_b64: Buffer.from('BBBB').toString('base64'), offset: 4, final: false };
    const results = await Promise.allSettled([service.put(input, HOST), otherWorker.put(input, HOST)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && String(rejected.reason)).toMatch(/Resume from 8/);
    expect((await service.info(id)).size_bytes).toBe(8);
    expect(await readFile(join(dataRoot, 'transfers', id.slice(0, 2), id), 'utf8')).toBe('AAAABBBB');
  });

  it('serializes appends without offsets so every accepted chunk is counted', async () => {
    const first = await put({ content_b64: Buffer.from('AAAA').toString('base64'), final: false });
    const id = first.transfer.id;
    const otherWorker = new AgentTransfersService({ db, settings, dataRoot });
    await Promise.all([
      service.put({ id, content_b64: Buffer.from('BBBB').toString('base64'), final: false }, HOST),
      otherWorker.put({ id, content_b64: Buffer.from('CCCC').toString('base64'), final: false }, HOST),
    ]);
    expect((await service.info(id)).size_bytes).toBe(12);
    expect(['AAAABBBBCCCC', 'AAAACCCCBBBB']).toContain(
      await readFile(join(dataRoot, 'transfers', id.slice(0, 2), id), 'utf8'),
    );
  });

  it('rejects a missing committed prefix instead of sealing a truncated file', async () => {
    const first = await put({ content_b64: Buffer.from('AAAA').toString('base64'), final: false });
    const id = first.transfer.id;
    const path = join(dataRoot, 'transfers', id.slice(0, 2), id);
    await truncate(path, 2);
    await expect(
      service.put({ id, content_b64: Buffer.from('BBBB').toString('base64'), offset: 4 }, HOST),
    ).rejects.toThrow(/shorter than its committed size/);
    expect(await readFile(path, 'utf8')).toBe('AA');
    expect((await service.info(id)).status).toBe(TRANSFER_STATUS_UPLOADING);
  });

  it('appends across calls and only computes the checksum when sealed', async () => {
    const first = await put({
      content_b64: Buffer.from('AAAA').toString('base64'),
      final: false,
    });
    expect(first.transfer.status).toBe(TRANSFER_STATUS_UPLOADING);
    expect(first.transfer.content_sha256).toBeNull();

    const second = await service.put(
      {
        id: first.transfer.id,
        content_b64: Buffer.from('BBBB').toString('base64'),
        offset: 4,
        final: true,
      },
      HOST,
    );
    expect(second.transfer.status).toBe(TRANSFER_STATUS_LIVE);
    expect(second.transfer.size_bytes).toBe(8);
    // Over the whole reassembled file, not the last chunk.
    expect(second.transfer.content_sha256).toBe(createHash('sha256').update('AAAABBBB').digest('hex'));
  });

  it('refuses a chunk whose offset does not match, and says where to resume', async () => {
    const first = await put({ content_b64: Buffer.from('AAAA').toString('base64'), final: false });
    await expect(
      service.put(
        { id: first.transfer.id, content_b64: Buffer.from('X').toString('base64'), offset: 99 },
        HOST,
      ),
    ).rejects.toThrow(/Resume from 4/);
  });

  it('refuses to append to a transfer that is already sealed', async () => {
    const first = await put();
    await expect(
      service.put({ id: first.transfer.id, content_b64: Buffer.from('X').toString('base64') }, HOST),
    ).rejects.toThrow(/no longer accepts chunks/);
  });

  it('an unsealed transfer cannot be fetched', async () => {
    const first = await put({ final: false });
    await expect(service.get(first.transfer.id)).rejects.toThrow(/still being uploaded/);
  });
});

describe('get', () => {
  it('returns the whole file when it fits, and marks it complete', async () => {
    const created = await put();
    const result = await service.get(created.transfer.id);
    expect(Buffer.from(result.content_b64, 'base64').toString()).toBe('hello world');
    expect(result.truncated).toBe(false);
    expect(result.next_offset).toBeNull();
  });

  it('pages with offset and max_bytes, handing back the next offset', async () => {
    const created = await put();
    const first = await service.get(created.transfer.id, { max_bytes: 5 });
    expect(Buffer.from(first.content_b64, 'base64').toString()).toBe('hello');
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBe(5);

    const second = await service.get(created.transfer.id, { offset: 5, max_bytes: 100 });
    expect(Buffer.from(second.content_b64, 'base64').toString()).toBe(' world');
    expect(second.truncated).toBe(false);
  });

  it('counts one download per completed fetch, not per slice', async () => {
    const created = await put();
    await service.get(created.transfer.id, { max_bytes: 5 });
    expect((await service.info(created.transfer.id)).download_count).toBe(0);
    await service.get(created.transfer.id, { offset: 5 });
    expect((await service.info(created.transfer.id)).download_count).toBe(1);
  });

  it('rejects an offset past the end of the file', async () => {
    const created = await put();
    await expect(service.get(created.transfer.id, { offset: 999 })).rejects.toThrow(/offset must be/);
  });

  it('reports a missing id as possibly expired rather than as a bare not-found', async () => {
    await expect(service.get('nope')).rejects.toThrow(/may have expired/);
  });
});

describe('sweepExpired', () => {
  it('unlinks the bytes and flips the row once the deadline passes', async () => {
    const created = await put({ ttl_seconds: 60 });
    const path = join(dataRoot, 'transfers', created.transfer.id.slice(0, 2), created.transfer.id);
    await stat(path); // present before

    const later = new Date(Date.parse(created.transfer.expires_at) + 1000).toISOString();
    const swept = await service.sweepExpired(later);

    expect(swept).toEqual({ expired: 1, bytes_freed: 11 });
    await expect(stat(path)).rejects.toThrow();
    expect(transferRows()[0]!['status']).toBe(TRANSFER_STATUS_EXPIRED);
    // The row survives, because agent_transfer_events points at it.
    expect(transferRows()).toHaveLength(1);
    expect(eventRows().some((row) => row['action'] === 'expired')).toBe(true);
  });

  it('is idempotent, so a second sweeper over the same rows is harmless', async () => {
    const created = await put({ ttl_seconds: 60 });
    const later = new Date(Date.parse(created.transfer.expires_at) + 1000).toISOString();
    await service.sweepExpired(later);
    expect(await service.sweepExpired(later)).toEqual({ expired: 0, bytes_freed: 0 });
  });

  it('leaves a transfer whose deadline has not arrived alone', async () => {
    await put({ ttl_seconds: 3600 });
    expect(await service.sweepExpired()).toEqual({ expired: 0, bytes_freed: 0 });
  });

  it('runs on read, so an expired file is never served between timer ticks', async () => {
    const created = await put({ ttl_seconds: 60 });
    // Reach into the row rather than waiting: the deadline is the only input.
    transferRows()[0]!['expiresAt'] = new Date(Date.now() - 1000).toISOString();
    await expect(service.get(created.transfer.id)).rejects.toThrow(/expired and its bytes are gone/);
    expect(await service.list()).toHaveLength(0);
  });

  it('frees quota, so a full pool recovers without anyone deleting anything', async () => {
    settings.store.set('transfers_quota_bytes', '15');
    const created = await put({ ttl_seconds: 60 });
    await expect(put()).rejects.toThrow(/pool is full/);
    transferRows()[0]!['expiresAt'] = new Date(Date.now() - 1000).toISOString();
    await expect(put()).resolves.toBeTruthy();
    expect(created.transfer.id).not.toBe(transferRows()[1]!['id']);
  });
});

describe('remove', () => {
  it('takes the bytes but keeps the row and its trail', async () => {
    const created = await put();
    const path = join(dataRoot, 'transfers', created.transfer.id.slice(0, 2), created.transfer.id);
    const view = await service.remove(created.transfer.id, { kind: 'admin', label: '3' });

    expect(view.status).toBe(TRANSFER_STATUS_DELETED);
    await expect(stat(path)).rejects.toThrow();
    expect(transferRows()).toHaveLength(1);
    const deleted = eventRows().find((row) => row['action'] === 'deleted');
    expect(deleted?.['actorKind']).toBe('admin');
    expect(deleted?.['actorLabel']).toBe('3');
  });

  it('is a no-op on something already retired', async () => {
    const created = await put();
    await service.remove(created.transfer.id, { kind: 'admin', label: null });
    const again = await service.remove(created.transfer.id, { kind: 'admin', label: null });
    expect(again.status).toBe(TRANSFER_STATUS_DELETED);
  });
});

describe('reconcileOrphans', () => {
  it('removes a file old enough that no row will ever claim it', async () => {
    const orphan = join(dataRoot, 'transfers', 'zz', 'zzzz-orphan');
    await mkdir(join(dataRoot, 'transfers', 'zz'), { recursive: true });
    await writeFile(orphan, 'left behind by a crash');
    const old = new Date(Date.now() - 7_200_000);
    await utimes(orphan, old, old);

    expect(await service.reconcileOrphans()).toEqual({ removed: 1 });
    await expect(stat(orphan)).rejects.toThrow();
  });

  it('spares a recent orphan, which may be an upload in flight elsewhere', async () => {
    const recent = join(dataRoot, 'transfers', 'zz', 'zzzz-recent');
    await mkdir(join(dataRoot, 'transfers', 'zz'), { recursive: true });
    await writeFile(recent, 'maybe still being written');
    expect(await service.reconcileOrphans()).toEqual({ removed: 0 });
    await stat(recent);
  });

  it('never touches a file a live row claims', async () => {
    const created = await put();
    const path = join(dataRoot, 'transfers', created.transfer.id.slice(0, 2), created.transfer.id);
    const old = new Date(Date.now() - 7_200_000);
    await utimes(path, old, old);
    expect(await service.reconcileOrphans()).toEqual({ removed: 0 });
    await stat(path);
  });

  it('is a no-op before anything has ever been uploaded', async () => {
    expect(await service.reconcileOrphans()).toEqual({ removed: 0 });
    expect(await readdir(dataRoot)).toEqual([]);
  });
});

describe('module state', () => {
  it('reports usage and live count alongside the switch', async () => {
    await put();
    await put({ final: false });
    const state = await service.adminState();
    expect(state.enabled).toBe(true);
    expect(state.used_bytes).toBe(22);
    // An unsealed upload holds bytes but is not yet a file anyone can fetch.
    expect(state.live_count).toBe(1);
  });

  it('defaults to off, so enabling is always a deliberate act', async () => {
    const fresh = new AgentTransfersService({ db, settings: createSettings(), dataRoot });
    expect(await fresh.getEnabled()).toBe(false);
  });

  it('refuses limits that contradict each other', async () => {
    await expect(service.setLimits({ default_ttl_seconds: 90_000 })).rejects.toThrow(
      /default_ttl_seconds must be/,
    );
    await expect(service.setLimits({ max_ttl_seconds: 1 })).rejects.toThrow(/max_ttl_seconds/);
    await expect(service.setLimits({ max_file_bytes: 2048, quota_bytes: 1024 })).rejects.toThrow(
      /at least max_file_bytes/,
    );
  });

  it('stores a coherent set', async () => {
    const state = await service.setLimits({
      default_ttl_seconds: 1800,
      max_ttl_seconds: 7200,
      max_file_bytes: 1024 * 1024,
      quota_bytes: 64 * 1024 * 1024,
    });
    expect(state.default_ttl_seconds).toBe(1800);
    expect(state.max_ttl_seconds).toBe(7200);
  });

  it('counts only live transfers for the AGENTS.md block', async () => {
    await put();
    await put({ final: false });
    expect(await service.availableCount()).toBe(1);
  });
});

describe('audit trail', () => {
  it('records the upload and every fetch, which is what stands in for access control', async () => {
    const created = await put({ username: 'chris' });
    await service.get(created.transfer.id);
    const events = await service.events(created.transfer.id);
    // Chronological: the upload, then what happened to it.
    expect(events.map((event) => event.action)).toEqual(['uploaded', 'downloaded']);
    expect(events.find((event) => event.action === 'uploaded')?.actor_label).toBe('chris');
  });

  it('renders a chunked upload in the order it happened', async () => {
    // The bug 0029 fixes: every one of these lands inside the same second, and
    // ordering on the second-precision `created_at` put "sealed at offset 2000"
    // above the chunk it follows -- a trail describing something that never
    // happened. `seq` is what makes this deterministic.
    const first = await put({ content_b64: Buffer.from('AAAA').toString('base64'), final: false });
    const id = first.transfer.id;
    await service.put(
      { id, content_b64: Buffer.from('BBBB').toString('base64'), offset: 4, final: false },
      HOST,
    );
    await service.put(
      { id, content_b64: Buffer.from('CCCC').toString('base64'), offset: 8, final: true },
      HOST,
    );
    const events = await service.events(id);
    expect(events.map((event) => event.action)).toEqual(['appended', 'appended', 'sealed']);
    expect(events.map((event) => event.detail)).toEqual([
      '4 bytes',
      '4 bytes at offset 4',
      '4 bytes at offset 8',
    ]);
  });

  it('scopes the trail to one transfer', async () => {
    const a = await put();
    const b = await put({ name: 'other.bin' });
    await service.get(b.transfer.id);
    expect(await service.events(a.transfer.id)).toHaveLength(1);
    expect(await service.events(b.transfer.id)).toHaveLength(2);
  });
});

describe('binary uploads', () => {
  const data = Buffer.from([0, 255, 128, 10, 0, 42]);
  const input = () => ({
    id: randomUUID(),
    name: 'blob.bin',
    size_bytes: data.length,
    content_sha256: createHash('sha256').update(data).digest('hex'),
    ttl_seconds: 600,
  });

  it('is idempotent, host-bound, and hides bytes until verified', async () => {
    const metadata = input();
    const created = await service.createBinary(metadata, HOST);
    expect((await service.createBinary(metadata, HOST)).id).toBe(created.id);
    expect(transferRows()).toHaveLength(1);
    await expect(service.createBinary({ ...metadata, size_bytes: 10 }, HOST)).rejects.toThrow(
      /different upload/,
    );
    await expect(
      service.appendBinary(created.id, 0, data.length, Readable.from([data]), { id: 8 } as Host),
    ).rejects.toThrow(/uploading host/);
    await expect(service.get(created.id)).rejects.toThrow(/still being uploaded/);
    await service.appendBinary(created.id, 0, data.length, Readable.from([data]), HOST);
    expect((await service.sealBinary(created.id, HOST)).content_sha256).toBe(metadata.content_sha256);
    expect((await service.sealBinary(created.id, HOST)).status).toBe('live');
    expect(Buffer.from((await service.get(created.id)).content_b64, 'base64')).toEqual(data);
  });

  it('resumes after disconnect, service restart and an uncommitted disk tail', async () => {
    const metadata = input();
    await service.createBinary(metadata, HOST);
    await service.appendBinary(metadata.id, 0, 2, Readable.from([data.subarray(0, 2)]), HOST);
    const broken = Readable.from(
      (async function* () {
        yield data.subarray(2, 3);
        throw new Error('connection lost');
      })(),
    );
    await expect(service.appendBinary(metadata.id, 2, 4, broken, HOST)).rejects.toThrow('connection lost');
    expect((await service.info(metadata.id)).size_bytes).toBe(2);
    const path = join(dataRoot, 'transfers', metadata.id.slice(0, 2), metadata.id);
    await appendFile(path, 'uncommitted tail');
    const restarted = new AgentTransfersService({ db, settings, dataRoot });
    await restarted.appendBinary(metadata.id, 2, 4, Readable.from([data.subarray(2)]), HOST);
    await restarted.sealBinary(metadata.id, HOST);
    expect(await readFile(path)).toEqual(data);
    expect(
      (await readdir(join(dataRoot, 'transfers', metadata.id.slice(0, 2)))).filter((f) =>
        f.endsWith('.part'),
      ),
    ).toHaveLength(0);
  });

  it('accepts only one concurrent writer at a confirmed offset', async () => {
    const metadata = input();
    await service.createBinary(metadata, HOST);
    const other = new AgentTransfersService({ db, settings, dataRoot });
    const results = await Promise.allSettled(
      [service, other].map((s) => s.appendBinary(metadata.id, 0, data.length, Readable.from([data]), HOST)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.info(metadata.id)).size_bytes).toBe(data.length);
  });

  it('reserves optional quotas before bytes arrive, including competing uploads', async () => {
    settings.store.set('transfers_quota_bytes', '10');
    const results = await Promise.allSettled([
      service.createBinary(input(), HOST),
      service.createBinary(input(), HOST),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.adminState()).used_bytes).toBe(data.length);
    await expect(put()).rejects.toThrow(/pool is full/);
  });

  it('refuses corrupt and incomplete uploads, and accepts empty files', async () => {
    const metadata = input();
    await service.createBinary(metadata, HOST);
    await expect(service.sealBinary(metadata.id, HOST)).rejects.toThrow(/incomplete/);
    await service.appendBinary(metadata.id, 0, data.length, Readable.from([Buffer.alloc(data.length)]), HOST);
    await expect(service.sealBinary(metadata.id, HOST)).rejects.toThrow(/SHA-256 mismatch/);
    expect((await service.info(metadata.id)).status).toBe('uploading');
    const empty = { ...input(), size_bytes: 0, content_sha256: createHash('sha256').digest('hex') };
    await service.createBinary(empty, HOST);
    expect((await service.sealBinary(empty.id, HOST)).status).toBe('live');
    const download = await service.openBinaryDownload(empty.id, 0, { kind: 'agent', hostId: 8, label: null });
    let bytes = 0;
    for await (const part of download.stream) bytes += part.length;
    expect(bytes).toBe(0);
  });

  it('never resurrects a transfer deleted during receipt', async () => {
    const metadata = input();
    await service.createBinary(metadata, HOST);
    const source = Readable.from(
      (async function* () {
        yield data.subarray(0, 2);
        await service.remove(metadata.id, { kind: 'system', label: 'test' });
        yield data.subarray(2);
      })(),
    );
    await expect(service.appendBinary(metadata.id, 0, data.length, source, HOST)).rejects.toThrow(/deleted/);
    expect((await service.info(metadata.id)).status).toBe('deleted');
  });

  it('refuses expiry during receipt and sweeps its files', async () => {
    const metadata = input();
    await service.createBinary(metadata, HOST);
    const source = Readable.from(
      (async function* () {
        yield data.subarray(0, 2);
        transferRows()[0]!['expiresAt'] = '2000-01-01T00:00:00Z';
        yield data.subarray(2);
      })(),
    );
    await expect(service.appendBinary(metadata.id, 0, data.length, source, HOST)).rejects.toThrow(/expired/);
    await service.sweepExpired();
    expect(await readdir(join(dataRoot, 'transfers', metadata.id.slice(0, 2)))).toEqual([]);
  });

  it('defaults to unlimited and preserves explicit limits above 64 MiB', async () => {
    expect((await service.getLimits()).max_file_bytes).toBe(0);
    expect((await service.getLimits()).quota_bytes).toBe(0);
    await service.setLimits({ max_file_bytes: 1024 ** 4, quota_bytes: 0 });
    expect((await service.getLimits()).max_file_bytes).toBe(1024 ** 4);
    await service.setLimits({ max_file_bytes: 0, quota_bytes: 0 });
  });
});

describe('binary storage failures', () => {
  it.each([1, 2])('keeps confirmed offset after ENOSPC at write %s', async (failureAt) => {
    const data = Buffer.from('binary data');
    const metadata = {
      id: randomUUID(),
      name: 'disk.bin',
      size_bytes: data.length,
      content_sha256: createHash('sha256').update(data).digest('hex'),
      ttl_seconds: 600,
    };
    await service.createBinary(metadata, HOST);
    const probe = await open(join(dataRoot, 'probe'), 'w+');
    const prototype = Object.getPrototypeOf(probe);
    const original = prototype.write;
    let writes = 0;
    const spy = vi.spyOn(prototype, 'write').mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (++writes === failureAt)
        return Promise.reject(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
      return original.apply(this, args);
    });
    try {
      await expect(
        service.appendBinary(metadata.id, 0, data.length, Readable.from([data]), HOST),
      ).rejects.toThrow('no space left');
    } finally {
      spy.mockRestore();
      await probe.close();
    }
    expect((await service.info(metadata.id)).size_bytes).toBe(0);
    await service.appendBinary(metadata.id, 0, data.length, Readable.from([data]), HOST);
    expect((await service.sealBinary(metadata.id, HOST)).content_sha256).toBe(metadata.content_sha256);
  });
});

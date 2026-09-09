import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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
import type { SettingsService } from '../../../src/services/settings.js';

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
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const child of node) paramsOf(child, out);
    return out;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('queryChunks' in obj) paramsOf(obj['queryChunks'], out);
    else if ('value' in obj) out.push(obj['value']);
  }
  return out;
}

type Row = Record<string, unknown>;

function createDb(): Database & { rows: Map<unknown, Row[]> } {
  const rows = new Map<unknown, Row[]>([
    [agentTransfers, []],
    [agentTransferEvents, []],
  ]);
  const get = (table: unknown): Row[] => {
    if (!rows.has(table)) rows.set(table, []);
    return rows.get(table)!;
  };

  const db = {
    rows,
    select() {
      return {
        from(table: unknown) {
          const result: Row[] = [...get(table)];
          const chain = {
            where: (predicate: unknown) => {
              const ids = new Set(paramsOf(predicate));
              const filtered = result.filter((row) => ids.has(row['id']));
              return Object.assign(Promise.resolve(filtered), {
                limit: () => Promise.resolve(filtered),
                orderBy: () => Promise.resolve(filtered),
              });
            },
            orderBy: () => Object.assign(Promise.resolve(result), { limit: () => Promise.resolve(result) }),
            limit: () => Promise.resolve(result),
            then: (resolve: (value: Row[]) => unknown) => Promise.resolve(result).then(resolve),
          };
          return chain;
        },
      };
    },
    insert(table: unknown) {
      return {
        values: (value: Row | Row[]) => {
          get(table).push(...(Array.isArray(value) ? value : [value]));
          return Promise.resolve([{ affectedRows: 1 }]);
        },
      };
    },
    update(table: unknown) {
      return {
        set: (patch: Row) => ({
          where: (predicate: unknown) => {
            const ids = new Set(paramsOf(predicate));
            for (const row of get(table)) {
              if (ids.has(row['id'])) Object.assign(row, patch);
            }
            return Promise.resolve([{ affectedRows: 1 }]);
          },
        }),
      };
    },
    delete(table: unknown) {
      return {
        where: (predicate: unknown) => {
          const ids = new Set(paramsOf(predicate));
          rows.set(
            table,
            get(table).filter((row) => !ids.has(row['id'])),
          );
          return Promise.resolve([{ affectedRows: 1 }]);
        },
      };
    },
  };
  return db as unknown as Database & { rows: Map<unknown, Row[]> };
}

/** A settings fake over a plain map, matching SettingsService's surface. */
function createSettings(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    getRaw: async (key: string) => store.get(key) ?? null,
    getWithMeta: async (key: string) => ({ value: store.get(key) ?? null, updatedAt: null }),
    getFlag: async (key: string, fallback = false) =>
      store.has(key) ? ['1', 'true', 'yes', 'on'].includes(String(store.get(key))) : fallback,
    getInt: async (key: string, fallback: number) =>
      store.has(key) ? Number(store.get(key)) : fallback,
    getString: async (key: string, fallback: string | null = null) => store.get(key) ?? fallback,
    set: async (key: string, value: string) => void store.set(key, value),
    setFlag: async (key: string, value: boolean) => void store.set(key, value ? '1' : '0'),
    setInt: async (key: string, value: number) => void store.set(key, String(value)),
    delete: async (key: string) => void store.delete(key),
    deleteIf: async () => true,
  } as unknown as SettingsService & { store: Map<string, string> };
}

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
    expect(result.transfer.content_sha256).toBe(
      createHash('sha256').update('hello world').digest('hex'),
    );
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
    const granted =
      (Date.parse(result.transfer.expires_at) - Date.parse(result.transfer.created_at)) / 1000;
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
    expect(second.transfer.content_sha256).toBe(
      createHash('sha256').update('AAAABBBB').digest('hex'),
    );
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
      service.put(
        { id: first.transfer.id, content_b64: Buffer.from('X').toString('base64') },
        HOST,
      ),
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
    await expect(service.setLimits({ quota_bytes: 1024 })).rejects.toThrow(/at least max_file_bytes/);
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

  it('scopes the trail to one transfer', async () => {
    const a = await put();
    const b = await put({ name: 'other.bin' });
    await service.get(b.transfer.id);
    expect(await service.events(a.transfer.id)).toHaveLength(1);
    expect(await service.events(b.transfer.id)).toHaveLength(2);
  });
});

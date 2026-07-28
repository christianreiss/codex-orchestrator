import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hosts, mcpSessionTokens } from '../../../src/db/schema.js';
import { sha256 } from '../../../src/security/hash.js';
import { McpSessionService } from '../../../src/services/mcp-session.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

/**
 * `/mcp` checks this bearer token ahead of the host api key, so three gates
 * carry its whole security value: the plaintext token never reaches the row,
 * an expired or unreadable `expires_at` denies, and a token that outlived its
 * host row denies. The clock is frozen so the 8h TTL is an exact assertion.
 */

const NOW = '2026-07-28T21:00:00Z';
const EIGHT_HOURS_ON = '2026-07-29T05:00:00Z';
const TOKEN = 'c'.repeat(64);

type Row = Record<string, unknown>;

interface Harness {
  db: DbFake;
  service: McpSessionService;
  selects: () => number;
}

function setup(opts: { tokens?: Row[]; hosts?: Row[] } = {}): Harness {
  const db = createDbFake();
  if (opts.tokens) db.tables.set(mcpSessionTokens, opts.tokens);
  if (opts.hosts) db.tables.set(hosts, opts.hosts);

  let selects = 0;
  const counting = {
    ...db,
    select: (fields?: unknown) => {
      selects += 1;
      return db.select(fields);
    },
  };
  return { db, service: new McpSessionService(counting as never), selects: () => selects };
}

function tokenRow(over: Row = {}): Row {
  return {
    id: 1,
    token: sha256(TOKEN),
    tokenEnc: null,
    hostId: 7,
    expiresAt: EIGHT_HOURS_ON,
    lastUsedAt: null,
    createdAt: '2026-07-28T18:00:00Z',
    updatedAt: '2026-07-28T18:00:00Z',
    ...over,
  };
}

function hostRow(over: Row = {}): Row {
  return {
    id: 7,
    fqdn: 'host.example',
    apiKey: 'k'.repeat(64),
    apiKeyHash: null,
    apiKeyEnc: null,
    status: 'active',
    secure: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mcp-session: issue', () => {
  it('persists only sha256(token) with an 8h expiry', async () => {
    const { service, db } = setup();
    const out = await service.issue(7);

    expect(out.token).toMatch(/^[a-f0-9]{64}$/);
    expect(out.expires_at).toBe(EIGHT_HOURS_ON);

    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]!.table).toBe(mcpSessionTokens);
    const stored = db.tables.get(mcpSessionTokens)![0]!;
    expect(stored.token).toBe(sha256(out.token));
    expect(stored.token).not.toBe(out.token);
    expect(stored.tokenEnc).toBeNull();
    expect(stored.hostId).toBe(7);
    expect(stored.expiresAt).toBe(out.expires_at);
    expect(stored.createdAt).toBe(NOW);
    expect(stored.updatedAt).toBe(NOW);
  });

  it('emits expires_at without milliseconds and honours an explicit ttlSeconds', async () => {
    const { service, db } = setup();
    const out = await service.issue(7, 60);

    expect(out.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(out.expires_at).toBe('2026-07-28T21:01:00Z');
    expect(db.tables.get(mcpSessionTokens)![0]!.expiresAt).toBe('2026-07-28T21:01:00Z');
  });

  it('mints a distinct token per call', async () => {
    const { service } = setup();
    const first = await service.issue(7);
    const second = await service.issue(7);
    expect(first.token).not.toBe(second.token);
  });
});

describe('mcp-session: verify', () => {
  it('rejects an empty token without querying the db', async () => {
    const { service, selects } = setup({ tokens: [tokenRow()], hosts: [hostRow()] });
    expect(await service.verify('')).toBeNull();
    expect(selects()).toBe(0);
  });

  it('rejects a token whose hash is not stored', async () => {
    const { service, db } = setup({ tokens: [tokenRow()], hosts: [hostRow()] });
    expect(await service.verify('d'.repeat(64))).toBeNull();
    expect(db.updates).toHaveLength(0);
  });

  it('rejects an expired row without looking up the host', async () => {
    const { service, db, selects } = setup({
      tokens: [tokenRow({ expiresAt: '2026-07-28T20:59:59Z' })],
      hosts: [hostRow()],
    });
    expect(await service.verify(TOKEN)).toBeNull();
    expect(selects()).toBe(1);
    expect(db.updates).toHaveLength(0);
  });

  it('rejects a row whose expires_at cannot be parsed', async () => {
    const { service, db } = setup({
      tokens: [tokenRow({ expiresAt: 'not-a-timestamp' })],
      hosts: [hostRow()],
    });
    expect(await service.verify(TOKEN)).toBeNull();
    expect(db.updates).toHaveLength(0);
  });

  it('rejects an unexpired token whose host row is gone', async () => {
    const { service, db } = setup({ tokens: [tokenRow()], hosts: [] });
    expect(await service.verify(TOKEN)).toBeNull();
    expect(db.updates).toHaveLength(0);
  });

  it('returns the host and stamps last_used_at on the matching token id', async () => {
    const host = hostRow();
    const other = tokenRow({ id: 2, token: sha256('other'), hostId: 9 });
    const { service, db } = setup({ tokens: [tokenRow(), other], hosts: [host] });

    expect(await service.verify(TOKEN)).toEqual(host);

    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]!.table).toBe(mcpSessionTokens);
    expect(db.updates[0]!.set).toEqual({ lastUsedAt: NOW, updatedAt: NOW });

    const [used, untouched] = db.tables.get(mcpSessionTokens)!;
    expect(used!.lastUsedAt).toBe(NOW);
    expect(used!.updatedAt).toBe(NOW);
    expect(untouched!.lastUsedAt).toBeNull();
    expect(untouched!.updatedAt).toBe('2026-07-28T18:00:00Z');
  });
});

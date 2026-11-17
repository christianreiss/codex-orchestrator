/**
 * Unit coverage for the fleet secrets store.
 *
 * The property this file exists to protect is narrow and absolute: a secret's
 * plaintext leaves the service through exactly two methods, `revealById` and
 * `getForHost`, and through nothing else. Every other read enumerates its
 * columns so ciphertext cannot ride along, and `toMetadata` re-picks the fields
 * on the way out — which is what makes the guarantee assertable here at all,
 * because `db-fake`'s `select(fields)` ignores the field list and hands back
 * whole seeded rows. The real-DB suite in `test/integration/secrets/` proves the
 * SQL half; this proves the half that survives a fake.
 *
 * The other load-bearing test is the fail-closed audit: `getForHost` must write
 * its `admin_events` security audit before returning plaintext and let a failing
 * write propagate. Ordinary MCP calls no longer write SQL access telemetry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql-proxy';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { adminEvents, secrets, versions, type Host } from '../../../src/db/schema.js';
import {
  SecretsService,
  SECRETS_ENABLED_FLAG,
  type SecretsService as SecretsServiceType,
} from '../../../src/services/secrets.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../src/http/errors.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINE_GROK, ENGINE_KIMI } from '../../../src/util/engine.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const keyring = testKeyring();
const host: Host = { id: 7, fqdn: 'host.example' } as unknown as Host;

type SecretSeed = {
  slug: string;
  value: string;
  name?: string;
  description?: string | null;
  engine?: string | null;
  tags?: string[];
  deletedAt?: string | null;
  sourceHostId?: number | null;
  sourceEngine?: string | null;
};

type LoggedEntry = { method: string; name: string | null; success: boolean; errorMessage: string | null };

interface Harness {
  db: DbFake;
  service: SecretsServiceType;
  logged: LoggedEntry[];
}

function makeHarness(
  seeds: SecretSeed[] = [],
  opts: { enabled?: boolean; logFails?: boolean } = {},
): Harness {
  const db = createDbFake();
  db.tables.set(
    secrets,
    seeds.map((seed, i) => ({
      id: i + 1,
      slug: seed.slug,
      name: seed.name ?? seed.slug,
      description: seed.description ?? null,
      valueEnc: encrypt(seed.value, keyring),
      engine: seed.engine ?? null,
      sourceHostId: seed.sourceHostId ?? null,
      sourceEngine: seed.sourceEngine ?? null,
      tags: seed.tags ?? null,
      tagsText: seed.tags?.join(' ') ?? null,
      createdAt: '2026-07-01T09:00:00Z',
      updatedAt: '2026-07-01T09:00:00Z',
      lastRotatedAt: '2026-07-01T09:00:00Z',
      deletedAt: seed.deletedAt ?? null,
    })),
  );
  db.tables.set(versions, [
    { name: SECRETS_ENABLED_FLAG, version: opts.enabled === false ? '0' : '1', updatedAt: 'x' },
  ]);

  const logged: LoggedEntry[] = [];
  const insert = db.insert.bind(db);
  db.insert = ((table: unknown) => {
    if (table !== adminEvents) return insert(table as never);
    return { values: async (row: { type: string; payload: { slug: string; success: boolean; error_code: string | null; engine: string | null } }) => {
      const payload = row.payload;
      logged.push({ method: row.type, name: `secret_get:${payload.slug}`, success: payload.success,
        errorMessage: payload.error_code, engine: payload.engine } as LoggedEntry);
      if (opts.logFails) throw new Error('audit write failed');
      return (insert(table as never) as { values: (row: unknown) => Promise<unknown> }).values(row);
    } };
  }) as typeof db.insert;
  return {
    db,
    logged,
    service: new SecretsService({ db: db as never, keyring }),
  };
}

describe('fleet-wide reads', () => {
  it.each([ENGINE_CODEX, ENGINE_CLAUDE, ENGINE_GROK, ENGINE_KIMI])('serves %s all legacy scopes and records the caller in the audit', async (caller) => {
    for (const scope of [null, ENGINE_CODEX, ENGINE_CLAUDE, ENGINE_GROK, ENGINE_KIMI]) {
      // Legacy DB fixtures prove old scope values cannot affect reads, even
      // before the migration removes the obsolete column.
      const { service, logged } = makeHarness([{ slug: 'fixture', value: 'fixture-value', engine: scope }]);
      await expect(service.getForHost('fixture', host, caller)).resolves.toMatchObject({ value: 'fixture-value' });
      expect(logged[0]).toMatchObject({ success: true, engine: caller });
      expect((await service.listForHost(host.id)).map(row => row.slug)).toEqual(['fixture']);
      expect((await service.searchForHost('fixture', host.id)).map(row => row.slug)).toEqual(['fixture']);
      expect(await service.availableCount()).toBe(1);
    }
  });
});

describe('create', () => {
  it('stores an sbox envelope and never the plaintext', async () => {
    const { db, service } = makeHarness();
    await service.create({ slug: 'gh-pat', name: 'GitHub PAT', value: 'ghp_supersecret' });

    const inserted = db.inserts.find((entry) => entry.table === secrets);
    const values = inserted?.values as Record<string, unknown>;
    expect(String(values['valueEnc'])).toMatch(/^sbox:v1:/);
    expect(JSON.stringify(values)).not.toContain('ghp_supersecret');
  });

  it('lower-cases and trims the slug', async () => {
    const { service } = makeHarness();
    const created = await service.create({ slug: '  GH-Pat  ', name: 'n', value: 'v' });
    expect(created.slug).toBe('gh-pat');
  });

  it.each([
    ['an empty slug', { slug: '', name: 'n', value: 'v' }],
    ['a slug with spaces', { slug: 'a b', name: 'n', value: 'v' }],
    ['a slug starting with a hyphen', { slug: '-lead', name: 'n', value: 'v' }],
    ['a slug over 96 characters', { slug: 'a'.repeat(97), name: 'n', value: 'v' }],
    ['an empty name', { slug: 'ok', name: '   ', value: 'v' }],
    ['an empty value', { slug: 'ok', name: 'n', value: '' }],
  ])('rejects %s', async (_label, input) => {
    const { service } = makeHarness();
    await expect(service.create(input as never)).rejects.toBeInstanceOf(ValidationError);
  });


  it('rejects a live duplicate slug', async () => {
    const { service } = makeHarness([{ slug: 'gh-pat', value: 'old' }]);
    await expect(
      service.create({ slug: 'gh-pat', name: 'n', value: 'new' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('revives and rotates a soft-deleted slug instead of colliding', async () => {
    // uniq_secrets_slug is on slug alone, so a soft-deleted row still owns it.
    // Throwing here would leave the operator with a slug they cannot reuse.
    const { db, service } = makeHarness([
      { slug: 'gh-pat', value: 'old', deletedAt: '2026-07-02T09:00:00Z' },
    ]);
    const revived = await service.create({ slug: 'gh-pat', name: 'fresh', value: 'new' });

    expect(revived.deletedAt).toBeNull();
    expect(revived.name).toBe('fresh');
    expect(db.updates.some((entry) => entry.table === secrets)).toBe(true);
    expect(db.inserts.some((entry) => entry.table === secrets)).toBe(false);
  });
});

describe('metadata reads', () => {
  it('never carries ciphertext or plaintext out of list()', async () => {
    const { service } = makeHarness([
      { slug: 'a', value: 'plaintext-alpha' },
      { slug: 'b', value: 'plaintext-beta' },
    ]);
    const serialized = JSON.stringify(await service.list());

    expect(serialized).not.toContain('sbox:');
    expect(serialized).not.toContain('valueEnc');
    expect(serialized).not.toContain('plaintext-alpha');
    expect(serialized).not.toContain('plaintext-beta');
  });

  it('returns every live row regardless of legacy scope', async () => {
    const { service } = makeHarness([
      { slug: 'shared', value: 'v', engine: null },
      { slug: 'codex-only', value: 'v', engine: ENGINE_CODEX },
      { slug: 'claude-only', value: 'v', engine: ENGINE_CLAUDE },
    ]);

    expect((await service.list()).map((s) => s.slug)).toEqual([
      'claude-only',
      'codex-only',
      'shared',
    ]);
  });

  it('excludes soft-deleted rows unless asked', async () => {
    const { service } = makeHarness([
      { slug: 'live', value: 'v' },
      { slug: 'gone', value: 'v', deletedAt: '2026-07-02T09:00:00Z' },
    ]);
    expect((await service.list()).map((s) => s.slug)).toEqual(['live']);
    expect((await service.list({ includeDeleted: true })).map((s) => s.slug)).toEqual([
      'gone',
      'live',
    ]);
  });
});

describe.each([false, true])('search (owner snapshot: %s)', (owned) => {
  function searchHarness(seeds: SecretSeed[]) {
    const harness = makeHarness(seeds);
    if (owned) {
      bindOwnerRuntime(harness.db, {
        assertOwner() {},
        state: new OwnerStateStore(new OwnerStateSnapshot({ epoch: 'ebd412b0-8141-44e1-92b5-4cf18af09cc9', sequence: 0n }, {
          secrets: harness.db.tables.get(secrets) as never,
          versions: harness.db.tables.get(versions) as never,
        })),
      } as OwnerRuntime);
      vi.spyOn(harness.db, 'select').mockImplementation(() => { throw new Error('owner search must not query SQL'); });
    }
    return harness;
  }

  it('matches every purpose word across metadata rather than one contiguous phrase', async () => {
    const { service } = searchHarness([
      { slug: 'certmaster-key', name: 'CertMaster root key passphrase', tags: ['root', 'passphrase'], value: 'private-value' },
      { slug: 'other-key', name: 'CertMaster root key', value: 'passphrase' },
    ]);

    expect((await service.search('certmaster root passphrase')).map((s) => s.slug)).toEqual(['certmaster-key']);
  });

  it('matches slug, name, description and tags', async () => {
    const { service } = searchHarness([
      { slug: 'gh-pat', name: 'GitHub token', value: 'v' },
      { slug: 'prod-db', name: 'Database', description: 'production postgres', value: 'v' },
      { slug: 'ckmk', name: 'Checkmk', value: 'v', tags: ['monitoring'] },
    ]);

    expect((await service.search('github')).map((s) => s.slug)).toEqual(['gh-pat']);
    expect((await service.search('postgres')).map((s) => s.slug)).toEqual(['prod-db']);
    expect((await service.search('monitoring')).map((s) => s.slug)).toEqual(['ckmk']);
  });

  it('degrades an empty query to a listing rather than an error', async () => {
    const { service } = searchHarness([{ slug: 'a', value: 'v' }, { slug: 'b', value: 'v' }]);
    expect((await service.search(' \t\n\u00a0 ')).map((s) => s.slug)).toEqual(['a', 'b']);
  });

  it('escapes LIKE metacharacters so "%" is not a wildcard', async () => {
    // A query of '%' matching everything would be a silent, confusing lie about
    // what the store holds.
    const { service } = searchHarness([{ slug: 'a', value: 'v' }, { slug: 'b', value: 'v' }]);
    expect(await service.search('%')).toEqual([]);
    expect(await service.search('_')).toEqual([]);
  });

  it('returns no ciphertext', async () => {
    const { service } = searchHarness([{ slug: 'gh-pat', value: 'plaintext-alpha' }]);
    const serialized = JSON.stringify(await service.search('gh'));
    expect(serialized).not.toContain('sbox:');
    expect(serialized).not.toContain('plaintext-alpha');
  });

  it('requires all words across distinct fields and ignores case, duplicates and Unicode whitespace', async () => {
    const { service } = searchHarness([
      { slug: 'certmaster-key', name: 'Root key', description: 'für Zürich', tags: ['passphrase'], value: 'v' },
      { slug: 'certmaster-other', name: 'Root key', description: 'für Zürich', value: 'passphrase' },
      { slug: 'certmaster-retired', name: 'Root key', description: 'für Zürich', tags: ['passphrase'], value: 'v', deletedAt: '2026-11-01T00:00:00Z' },
    ]);
    const query = '  CERTMASTER\tROOT\nPASSphrase\u00a0ZÜRICH root ';
    expect((await service.search(query, { includeDeleted: true })).map(s => s.slug)).toEqual(['certmaster-key']);
    expect((await service.searchForHost(query, host.id)).map(s => s.slug)).toEqual(['certmaster-key']);
    expect(await service.search('certmaster absent')).toEqual([]);
  });

  it('ranks by matching metadata fields then slug before applying the limit', async () => {
    const { service } = searchHarness([
      { slug: 'z', name: 'database token', description: 'production database', tags: ['production'], value: 'v' },
      { slug: 'b', name: 'production database', value: 'v' },
      { slug: 'a', name: 'production database', value: 'v' },
    ]);
    expect((await service.search('production database')).map(s => s.slug)).toEqual(['z', 'a', 'b']);
    expect((await service.search('database production database', { limit: 2 })).map(s => s.slug)).toEqual(['z', 'a']);
  });

  it('honors the host search limit after ranking and filters', async () => {
    const { service } = searchHarness([
      { slug: 'a-retired', name: 'database', tags: ['database'], value: 'v', deletedAt: '2026-11-01T00:00:00Z' },
      { slug: 'b', name: 'database', value: 'v' },
      { slug: 'z', name: 'database', tags: ['database'], value: 'v', sourceHostId: host.id },
    ]);
    expect(await service.searchForHost('database', host.id, 1)).toMatchObject([{ slug: 'z', owned_by_you: true }]);
    expect((await service.searchForHost('', host.id, 1)).map(s => s.slug)).toEqual(['b']);
    expect((await service.searchForHost('database', host.id)).map(s => s.slug)).toEqual(['z', 'b']);
  });

  it('validates the host search limit instead of permitting surprising slice bounds', async () => {
    const { service } = searchHarness([]);
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]) {
      await expect(service.searchForHost('', host.id, limit as number)).rejects.toMatchObject({ code: 'validation_failed', param: 'limit' });
    }
    await expect(service.searchForHost('', host.id, 50)).resolves.toEqual([]);
  });

  it('allows explicit host search limits above the default of 50', async () => {
    const { service } = searchHarness(Array.from({ length: 101 }, (_, i) => ({
      slug: `fixture-${String(i).padStart(3, '0')}`, name: 'database', value: 'v',
    })));
    expect(await service.searchForHost('database', host.id)).toHaveLength(50);
    expect(await service.searchForHost('database', host.id, 100)).toHaveLength(100);
    expect(await service.searchForHost('', host.id, 100)).toHaveLength(100);
  });

  it('keeps percent, underscore and backslash literal in individual words', async () => {
    const { service } = searchHarness([
      { slug: 'literal', name: '100% root_key C:\\keys', value: 'v' },
      { slug: 'wildcard', name: '1000 rootXkey C:keys', value: 'v' },
    ]);
    expect((await service.search('100% root_key C:\\keys')).map(s => s.slug)).toEqual(['literal']);
  });

  it('rejects oversized queries without truncating away required words', async () => {
    const { service } = searchHarness([]);
    await expect(service.search('x'.repeat(1001))).rejects.toMatchObject({ code: 'validation_failed', param: 'query' });
    await expect(service.search(Array.from({ length: 33 }, (_, i) => `term${i}`).join(' '))).rejects.toMatchObject({ code: 'validation_failed', param: 'query' });
    await expect(service.search('x'.repeat(1000))).resolves.toEqual([]);
    await expect(service.search(Array.from({ length: 32 }, (_, i) => `term${i}`).join(' '))).resolves.toEqual([]);
    await expect(service.search('root '.repeat(33))).resolves.toEqual([]);
  });
});

it('builds AND-of-OR SQL with escaped terms and never selects secret ciphertext', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [] };
  });
  await new SecretsService({ db: db as never }).search('100% root_key C:\\keys root_key');
  expect(queries).toHaveLength(1);
  const query = queries[0]!;
  expect(query.sql).not.toContain('value_enc');
  expect(query.sql).toContain('`secrets`.`deleted_at` is null and (');
  expect(query.sql.match(/\) and \(/g)).toHaveLength(2);
  expect(query.sql.match(/ like \?/g)).toHaveLength(12);
  expect(query.params).toEqual(['%100\\%%', '%root\\_key%', '%c:\\\\keys%'].flatMap(pattern => Array(4).fill(pattern)));
});

describe('revealById', () => {
  it('round-trips the exact plaintext', async () => {
    const { service } = makeHarness([{ slug: 'gh-pat', value: 'ghp_supersecret' }]);
    const revealed = await service.revealById(1);
    expect(revealed.value).toBe('ghp_supersecret');
    expect(revealed.secret.slug).toBe('gh-pat');
  });

  it('404s a soft-deleted secret', async () => {
    const { service } = makeHarness([
      { slug: 'gh-pat', value: 'v', deletedAt: '2026-07-02T09:00:00Z' },
    ]);
    await expect(service.revealById(1)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('getForHost', () => {
  it('returns the plaintext and audits the read with the slug', async () => {
    const { db, service, logged } = makeHarness([{ slug: 'gh-pat', value: 'ghp_supersecret' }]);
    const payload = await service.getForHost('gh-pat', host, ENGINE_CODEX);

    expect(payload.value).toBe('ghp_supersecret');
    const audit = db.tables.get(adminEvents)?.[0];
    expect(audit).toMatchObject({ type: 'secret.read', hostId: 7,
      payload: { slug: 'gh-pat', success: true, error_code: null, engine: 'codex' } });
    expect(JSON.stringify(audit)).not.toContain('ghp_supersecret');
    expect(logged).toEqual([
      expect.objectContaining({
        method: 'secret.read',
        name: 'secret_get:gh-pat',
        success: true,
      }),
    ]);
  });

  it('rejects and returns nothing when the audit write fails', async () => {
    // Fail-closed: no trail, no secret. If this ever resolves, every claim about
    // the credential audit trail becomes false.
    const { service } = makeHarness([{ slug: 'gh-pat', value: 'ghp_supersecret' }], {
      logFails: true,
    });
    await expect(service.getForHost('gh-pat', host, ENGINE_CODEX)).rejects.toThrow(
      'audit write failed',
    );
  });

  it('audits a miss with success: false and throws', async () => {
    const { service, logged } = makeHarness([{ slug: 'gh-pat', value: 'v' }]);
    await expect(service.getForHost('nope', host, ENGINE_CODEX)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(logged).toEqual([
      expect.objectContaining({ name: 'secret_get:nope', success: false, errorMessage: 'not_found' }),
    ]);
  });


  it('refuses to serve a soft-deleted secret without a restart', async () => {
    const { service } = makeHarness([
      { slug: 'gh-pat', value: 'v', deletedAt: '2026-07-02T09:00:00Z' },
    ]);
    await expect(service.getForHost('gh-pat', host, ENGINE_CODEX)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('throws rather than leaking the envelope when the keyring cannot decrypt', async () => {
    const { db, service } = makeHarness([{ slug: 'gh-pat', value: 'v' }]);
    const rows = db.tables.get(secrets) as Array<Record<string, unknown>>;
    rows[0]!['valueEnc'] = 'sbox:v1:kid=legacy:bm90LWEtcmVhbC1jaXBoZXJ0ZXh0';

    await expect(service.getForHost('gh-pat', host, ENGINE_CODEX)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('refuses every read while the module is disabled', async () => {
    const { service, logged } = makeHarness([{ slug: 'gh-pat', value: 'v' }], { enabled: false });
    await expect(service.getForHost('gh-pat', host, ENGINE_CODEX)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(logged[0]).toMatchObject({ success: false, errorMessage: 'secrets_disabled' });
  });
});

describe('host listing honours the module switch', () => {
  it('hands agents a snake_case payload with no id and no ciphertext', async () => {
    // The agent-facing shape is deliberately not the internal SecretMetadata:
    // the rest of the MCP surface spells its fields snake_case, and returning
    // the internal type made secret_list disagree with secret_get's own
    // `last_rotated_at` inside one tool family. Pinned as an exact key list so a
    // future field cannot ride along into an agent contract unnoticed.
    const { service } = makeHarness([
      { slug: 'gh-pat', name: 'GitHub PAT', value: 'ghp_supersecret', tags: ['git'] },
    ]);
    const listed = await service.listForHost();

    expect(Object.keys(listed[0]!).sort()).toEqual([
      'description',
      'last_rotated_at',
      'name',
      'owned_by_you',
      'slug',
      'tags',
    ]);
    expect(JSON.stringify(listed)).not.toContain('ghp_supersecret');
    expect(JSON.stringify(listed)).not.toContain('sbox:');

    // And it agrees with secret_get's own spelling.
    const fetched = await service.getForHost('gh-pat', host, ENGINE_CODEX);
    expect(fetched).toHaveProperty('last_rotated_at');
    expect(await service.searchForHost('gh')).toEqual(listed);
  });

  it('lists nothing while disabled and everything once enabled', async () => {
    const off = makeHarness([{ slug: 'gh-pat', value: 'v' }], { enabled: false });
    expect(await off.service.listForHost()).toEqual([]);
    expect(await off.service.searchForHost('gh')).toEqual([]);

    const on = makeHarness([{ slug: 'gh-pat', value: 'v' }]);
    expect((await on.service.listForHost()).map((s) => s.slug)).toEqual(['gh-pat']);
    expect((await on.service.searchForHost('gh')).map((s) => s.slug)).toEqual(['gh-pat']);
  });
});

describe('update', () => {
  it('reports rotated: false and leaves last_rotated_at alone for an unchanged value', async () => {
    const { service } = makeHarness([{ slug: 'gh-pat', value: 'same' }]);
    const result = await service.update(1, { value: 'same' });
    expect(result?.rotated).toBe(false);
    expect(result?.secret.lastRotatedAt).toBe('2026-07-01T09:00:00Z');
  });

  it('reports rotated: true and advances last_rotated_at for a changed value', async () => {
    const { service } = makeHarness([{ slug: 'gh-pat', value: 'old' }]);
    const result = await service.update(1, { value: 'new' });
    expect(result?.rotated).toBe(true);
    expect(result?.secret.lastRotatedAt).not.toBe('2026-07-01T09:00:00Z');
    expect(await service.revealById(1)).toMatchObject({ value: 'new' });
  });

  it('re-encrypts rather than storing the new value in the clear', async () => {
    const { db, service } = makeHarness([{ slug: 'gh-pat', value: 'old' }]);
    await service.update(1, { value: 'brand-new-secret' });
    const patch = db.updates.find((entry) => entry.table === secrets)?.set ?? {};
    expect(String(patch['valueEnc'])).toMatch(/^sbox:v1:/);
    expect(JSON.stringify(patch)).not.toContain('brand-new-secret');
  });

  it('leaves omitted fields untouched and clears an explicit null', async () => {
    const { service } = makeHarness([
      { slug: 'gh-pat', name: 'GitHub', description: 'old text', value: 'v' },
    ]);
    const kept = await service.update(1, { name: 'GitHub renamed' });
    expect(kept?.secret.description).toBe('old text');
    const cleared = await service.update(1, { description: null });
    expect(cleared?.secret.description).toBeNull();
  });

  it('returns null for an unknown or soft-deleted id', async () => {
    const { service } = makeHarness([
      { slug: 'gone', value: 'v', deletedAt: '2026-07-02T09:00:00Z' },
    ]);
    expect(await service.update(1, { name: 'x' })).toBeNull();
    expect(await service.update(99, { name: 'x' })).toBeNull();
  });

  it('rejects an empty value and an empty name', async () => {
    const { service } = makeHarness([{ slug: 'gh-pat', value: 'v' }]);
    await expect(service.update(1, { value: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.update(1, { name: '  ' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('softDelete', () => {
  it('hides the row from every read path', async () => {
    const { service } = makeHarness([{ slug: 'gh-pat', value: 'v' }]);
    const deleted = await service.softDelete(1);

    expect(deleted?.deletedAt).not.toBeNull();
    expect(await service.list()).toEqual([]);
    expect(await service.findById(1)).toBeNull();
    await expect(service.getForHost('gh-pat', host, ENGINE_CODEX)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('returns null for an unknown id', async () => {
    const { service } = makeHarness();
    expect(await service.softDelete(99)).toBeNull();
  });
});

describe('module state', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = makeHarness([{ slug: 'gh-pat', value: 'v' }], { enabled: false });
  });

  it('reads disabled when the flag row says 0', async () => {
    expect(await harness.service.getEnabled()).toBe(false);
    expect(await harness.service.adminState()).toMatchObject({ enabled: false, count: 1 });
  });

  it('reads disabled when the flag row is absent entirely', async () => {
    // The fresh-deploy case: no row at all must not read as enabled.
    harness.db.tables.set(versions, []);
    expect(await harness.service.getEnabled()).toBe(false);
  });

  it('flips the flag and reports the new state', async () => {
    expect(await harness.service.setEnabled(true)).toMatchObject({ enabled: true });
    expect(await harness.service.getEnabled()).toBe(true);
  });

  it('counts all live rows regardless of legacy engine scope', async () => {
    const scoped = makeHarness([
      { slug: 'shared', value: 'v' },
      { slug: 'claude-only', value: 'v', engine: ENGINE_CLAUDE },
      { slug: 'gone', value: 'v', deletedAt: '2026-07-02T09:00:00Z' },
    ]);
    expect(await scoped.service.availableCount()).toBe(2);
  });
});

/**
 * The client-owned lifecycle. Reading is open to every host; writing is not.
 *
 * The property that matters: a secret an operator provisioned — the shared
 * infrastructure credentials, like a DNS API key every node authenticates
 * with — cannot be overwritten by whichever agent happens to guess its slug.
 * Without that, one compromised or confused host silently repoints the fleet.
 */
describe('secret_store / secret_delete ownership', () => {
  const otherHost: Host = { id: 99, fqdn: 'other.example' } as unknown as Host;

  it('creates a secret owned by the calling host', async () => {
    const { service } = makeHarness();
    const res = await service.storeForHost(
      { slug: 'mine', name: 'Mine', value: 'v1', description: 'what it opens' },
      host,
      ENGINE_CODEX,
    );
    expect(res.status).toBe('created');
    expect(res.secret.owned_by_you).toBe(true);

    const stored = await service.findBySlug('mine');
    expect(stored?.sourceHostId).toBe(host.id);
    expect(stored?.sourceEngine).toBe(ENGINE_CODEX);
  });

  it('rotates its own secret and reports whether the value moved', async () => {
    const { service } = makeHarness([
      { slug: 'mine', value: 'v1', sourceHostId: host.id, sourceEngine: ENGINE_CODEX },
    ]);
    expect((await service.storeForHost({ slug: 'mine', name: 'Mine', value: 'v1' }, host, ENGINE_CODEX)).status).toBe(
      'unchanged',
    );
    expect((await service.storeForHost({ slug: 'mine', name: 'Mine', value: 'v2' }, host, ENGINE_CODEX)).status).toBe(
      'rotated',
    );
    expect((await service.getForHost('mine', host, ENGINE_CODEX)).value).toBe('v2');
  });

  it('refuses to overwrite an operator-created secret', async () => {
    // The powerdns-api-key case, exactly.
    const { service } = makeHarness([{ slug: 'powerdns-api-key', value: 'real', sourceHostId: null }]);
    await expect(
      service.storeForHost({ slug: 'powerdns-api-key', name: 'x', value: 'hijack' }, host, ENGINE_CODEX),
    ).rejects.toBeInstanceOf(ConflictError);
    // ...and the stored value is untouched.
    expect((await service.getForHost('powerdns-api-key', host, ENGINE_CODEX)).value).toBe('real');
  });

  it('refuses to overwrite another host secret', async () => {
    const { service } = makeHarness([
      { slug: 'theirs', value: 'real', sourceHostId: otherHost.id },
    ]);
    await expect(
      service.storeForHost({ slug: 'theirs', name: 'x', value: 'hijack' }, host, ENGINE_CODEX),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('still lets every host READ what it may not write', async () => {
    // Ownership narrows writing only. An agent must still be able to use a
    // credential an operator provisioned — that is the entire point of the store.
    const { service } = makeHarness([{ slug: 'powerdns-api-key', value: 'real', sourceHostId: null }]);
    expect((await service.getForHost('powerdns-api-key', host, ENGINE_CODEX)).value).toBe('real');
    expect((await service.listForHost(host.id)).map((s) => s.slug)).toEqual(['powerdns-api-key']);
    expect((await service.listForHost(host.id))[0]!.owned_by_you).toBe(false);
  });

  it('deletes its own secret and refuses the others', async () => {
    const { service } = makeHarness([
      { slug: 'mine', value: 'v', sourceHostId: host.id },
      { slug: 'theirs', value: 'v', sourceHostId: otherHost.id },
      { slug: 'operator', value: 'v', sourceHostId: null },
    ]);
    expect(await service.deleteForHost('mine', host, ENGINE_CODEX)).toMatchObject({ status: 'deleted' });
    await expect(service.getForHost('mine', host, ENGINE_CODEX)).rejects.toBeInstanceOf(NotFoundError);

    await expect(service.deleteForHost('theirs', host, ENGINE_CODEX)).rejects.toBeInstanceOf(ConflictError);
    await expect(service.deleteForHost('operator', host, ENGINE_CODEX)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses to adopt another host retired slug', async () => {
    // A soft-deleted row still owns its slug. Reviving it must not let a
    // different host inherit a name other agents may already have learned.
    const { service } = makeHarness([
      { slug: 'retired', value: 'v', sourceHostId: otherHost.id, deletedAt: '2026-07-02T09:00:00Z' },
    ]);
    await expect(
      service.storeForHost({ slug: 'retired', name: 'x', value: 'v' }, host, ENGINE_CODEX),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses every write while the module is disabled', async () => {
    const { service } = makeHarness([], { enabled: false });
    await expect(
      service.storeForHost({ slug: 'mine', name: 'x', value: 'v' }, host, ENGINE_CODEX),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.deleteForHost('mine', host, ENGINE_CODEX)).rejects.toBeInstanceOf(NotFoundError);
  });
});

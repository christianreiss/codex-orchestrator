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
 * its `mcp_access_logs` row *before* returning a value and must let a failing
 * write propagate. `mcp-server.ts` also logs every `tools/call`, but as a bare
 * `secret_get` with no slug inside a swallowing try/catch — so without this,
 * "every credential read is audited" would be false and nothing would say so.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { secrets, versions, type Host } from '../../../src/db/schema.js';
import {
  SecretsService,
  SECRETS_ENABLED_FLAG,
  visibleToEngine,
  type SecretsService as SecretsServiceType,
} from '../../../src/services/secrets.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../src/http/errors.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../../../src/util/engine.js';
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
  const accessLog = {
    log: async (entry: LoggedEntry) => {
      logged.push(entry);
      if (opts.logFails) throw new Error('audit write failed');
    },
  };
  return {
    db,
    logged,
    service: new SecretsService({
      db: db as never,
      keyring,
      accessLog: accessLog as never,
    }),
  };
}

describe('visibleToEngine', () => {
  it('treats null, undefined and empty as every engine', () => {
    for (const rowEngine of [null, undefined, '']) {
      expect(visibleToEngine(rowEngine, ENGINE_CODEX)).toBe(true);
      expect(visibleToEngine(rowEngine, ENGINE_CLAUDE)).toBe(true);
    }
  });

  it('hides an engine-scoped row from the other engine', () => {
    expect(visibleToEngine(ENGINE_CODEX, ENGINE_CODEX)).toBe(true);
    expect(visibleToEngine(ENGINE_CODEX, ENGINE_CLAUDE)).toBe(false);
    expect(visibleToEngine(ENGINE_CLAUDE, ENGINE_CODEX)).toBe(false);
  });

  it('shows every row when the caller declares no engine', () => {
    expect(visibleToEngine(ENGINE_CLAUDE, null)).toBe(true);
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

  it('rejects an unknown engine', async () => {
    const { service } = makeHarness();
    await expect(
      service.create({ slug: 'ok', name: 'n', value: 'v', engine: 'gemini' as never }),
    ).rejects.toBeInstanceOf(ValidationError);
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

  it('returns every live row when the caller declares no engine', async () => {
    // Engine *filtering* is asserted in test/integration/secrets/db.test.ts, not
    // here: the predicate is `engine IS NULL OR engine = ?`, and db-fake's
    // where-clause handling degrades on `or(...)` to a loose scan that drops the
    // `IS NULL` half — so a passing assertion here would prove nothing about the
    // SQL and a failing one would be the fake's fault. The pure predicate is
    // covered by the `visibleToEngine` block above.
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

describe('search', () => {
  it('matches slug, name, description and tags', async () => {
    const { service } = makeHarness([
      { slug: 'gh-pat', name: 'GitHub token', value: 'v' },
      { slug: 'prod-db', name: 'Database', description: 'production postgres', value: 'v' },
      { slug: 'ckmk', name: 'Checkmk', value: 'v', tags: ['monitoring'] },
    ]);

    expect((await service.search('github')).map((s) => s.slug)).toEqual(['gh-pat']);
    expect((await service.search('postgres')).map((s) => s.slug)).toEqual(['prod-db']);
    expect((await service.search('monitoring')).map((s) => s.slug)).toEqual(['ckmk']);
  });

  it('degrades an empty query to a listing rather than an error', async () => {
    const { service } = makeHarness([{ slug: 'a', value: 'v' }, { slug: 'b', value: 'v' }]);
    expect((await service.search('   ')).map((s) => s.slug)).toEqual(['a', 'b']);
  });

  it('escapes LIKE metacharacters so "%" is not a wildcard', async () => {
    // A query of '%' matching everything would be a silent, confusing lie about
    // what the store holds.
    const { service } = makeHarness([{ slug: 'a', value: 'v' }, { slug: 'b', value: 'v' }]);
    expect(await service.search('%')).toEqual([]);
    expect(await service.search('_')).toEqual([]);
  });

  it('returns no ciphertext', async () => {
    const { service } = makeHarness([{ slug: 'gh-pat', value: 'plaintext-alpha' }]);
    const serialized = JSON.stringify(await service.search('gh'));
    expect(serialized).not.toContain('sbox:');
    expect(serialized).not.toContain('plaintext-alpha');
  });
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
    const { service, logged } = makeHarness([{ slug: 'gh-pat', value: 'ghp_supersecret' }]);
    const payload = await service.getForHost('gh-pat', host, ENGINE_CODEX);

    expect(payload.value).toBe('ghp_supersecret');
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

  it('hides a secret scoped to the other engine, and audits the miss', async () => {
    const { service, logged } = makeHarness([
      { slug: 'claude-only', value: 'v', engine: ENGINE_CLAUDE },
    ]);
    await expect(service.getForHost('claude-only', host, ENGINE_CODEX)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(logged[0]).toMatchObject({ success: false, errorMessage: 'not_found' });
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
    const listed = await service.listForHost(null);

    expect(Object.keys(listed[0]!).sort()).toEqual([
      'description',
      'engine',
      'last_rotated_at',
      'name',
      'slug',
      'tags',
    ]);
    expect(JSON.stringify(listed)).not.toContain('ghp_supersecret');
    expect(JSON.stringify(listed)).not.toContain('sbox:');

    // And it agrees with secret_get's own spelling.
    const fetched = await service.getForHost('gh-pat', host, ENGINE_CODEX);
    expect(fetched).toHaveProperty('last_rotated_at');
    expect(await service.searchForHost('gh', null)).toEqual(listed);
  });

  // Passing `null` for the engine keeps `or(...)` out of the where clause; see
  // the note on engine filtering above.
  it('lists nothing while disabled and everything once enabled', async () => {
    const off = makeHarness([{ slug: 'gh-pat', value: 'v' }], { enabled: false });
    expect(await off.service.listForHost(null)).toEqual([]);
    expect(await off.service.searchForHost('gh', null)).toEqual([]);

    const on = makeHarness([{ slug: 'gh-pat', value: 'v' }]);
    expect((await on.service.listForHost(null)).map((s) => s.slug)).toEqual(['gh-pat']);
    expect((await on.service.searchForHost('gh', null)).map((s) => s.slug)).toEqual(['gh-pat']);
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

  it('counts only rows visible to the engine', async () => {
    const scoped = makeHarness([
      { slug: 'shared', value: 'v' },
      { slug: 'claude-only', value: 'v', engine: ENGINE_CLAUDE },
      { slug: 'gone', value: 'v', deletedAt: '2026-07-02T09:00:00Z' },
    ]);
    expect(await scoped.service.availableCount(ENGINE_CODEX)).toBe(1);
    expect(await scoped.service.availableCount(ENGINE_CLAUDE)).toBe(2);
    expect(await scoped.service.availableCount(null)).toBe(2);
  });
});

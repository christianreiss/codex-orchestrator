/**
 * Fleet secrets store: the WORKING credentials agents use once they are running
 * — GitHub PATs, database passwords, Bookstack/Checkmk tokens, SSH keys,
 * third-party API keys for MCP servers and services.
 *
 * Deliberately not engine-boot auth. `canonical-auth-store.ts` owns the login
 * material that gets an agent *started*, behind a live runner-verification gate;
 * these rows have a different lifecycle, different consumers and a different
 * blast radius, and the two are never merged. There is no runner that can
 * verify a database password, so nothing here pretends to have a verification
 * state — `lastRotatedAt` and the admin surface are the whole story.
 *
 * Delivery is MCP-only: nothing here is ever written to a host filesystem, so
 * there is no ownership ledger to maintain and revocation is one UPDATE that
 * takes effect on the next read.
 */
import { and, asc, eq, isNull, like, or, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { secrets, versions, type Host, type Secret } from '../db/schema.js';
import type { Keyring } from '../security/keyring.js';
import { encrypt as encryptSecret, decryptOrNull } from '../security/secret-box.js';
import type { McpAccessLogService } from './mcp-access-log.js';
import { parseTags, sortedLowercase } from './memory-tags.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { isEngine, type Engine } from '../util/engine.js';
import { wsPublisher } from '../ws/publisher.js';

/** The `versions` row that switches the whole module on. Absent means off. */
export const SECRETS_ENABLED_FLAG = 'secrets_module_enabled';

/** Same grammar as `shared_memories`; the column is VARCHAR(96). */
const SLUG_RE = /^[a-z0-9][a-z0-9._:-]*$/;
const SLUG_MAX = 96;
const DEFAULT_LIST_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 50;

/**
 * The column set every metadata read selects. `valueEnc` is absent by
 * construction, and that absence is the entire guarantee: `db.select()` with no
 * argument returns the whole row, so forgetting this object is the single most
 * likely way ciphertext reaches a list response. `loadEnvelope()` is the only
 * function in this file that names `valueEnc`, and exactly two public methods
 * call it. `tagsText` is a search denormalization and is not part of the DTO.
 */
const METADATA_COLUMNS = {
  id: secrets.id,
  slug: secrets.slug,
  name: secrets.name,
  description: secrets.description,
  engine: secrets.engine,
  tags: secrets.tags,
  createdAt: secrets.createdAt,
  updatedAt: secrets.updatedAt,
  lastRotatedAt: secrets.lastRotatedAt,
  deletedAt: secrets.deletedAt,
} as const;

/** Everything about a secret except the secret. Nothing here decrypts. */
export interface SecretMetadata {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  engine: Engine | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastRotatedAt: string | null;
  deletedAt: string | null;
}

/**
 * What `secret_list` / `secret_search` hand an agent: everything needed to pick
 * the right credential, and nothing else.
 *
 * A separate shape from `SecretMetadata` on purpose. Returning the internal type
 * would put camelCase keys on an agent-facing payload, which the rest of the MCP
 * surface spells snake_case (`shared_memory_list` → `content_length`,
 * `created_at`), and would have made `secret_list` disagree with `secret_get`'s
 * own `last_rotated_at` inside one tool family. It also drops `id` — agents
 * address secrets by slug and never by number — and `deleted_at`, which is
 * always null here because a listing only contains live rows.
 */
export interface SecretListing {
  slug: string;
  name: string;
  description: string | null;
  engine: Engine | null;
  tags: string[];
  last_rotated_at: string | null;
}

export function toSecretListing(row: SecretMetadata): SecretListing {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    engine: row.engine,
    tags: row.tags,
    last_rotated_at: row.lastRotatedAt,
  };
}

/** What `secret_get` hands an agent. The one shape that carries a value. */
export interface SecretPayload {
  slug: string;
  name: string;
  description: string | null;
  value: string;
  engine: Engine | null;
  tags: string[];
  last_rotated_at: string | null;
}

export interface CreateSecretInput {
  slug: string;
  name: string;
  value: string;
  description?: string | null;
  engine?: Engine | null;
  tags?: string[];
}

/** An omitted field is left alone; an explicit `null` clears it. */
export interface UpdateSecretInput {
  name?: string;
  value?: string;
  description?: string | null;
  engine?: Engine | null;
  tags?: string[];
}

export interface ListOptions {
  engine?: Engine | null;
  includeDeleted?: boolean;
  limit?: number;
}

export interface SecretsModuleState {
  enabled: boolean;
  updated_at: string | null;
  count: number;
}

export interface SecretsServiceDeps {
  db: Database;
  /**
   * Required for anything that encrypts or decrypts — which is `create`,
   * `update`, `revealById` and `getForHost`, and nothing else. Optional because
   * `HostAgentsService` constructs this service purely to answer "is the module
   * on, and how many secrets can this engine see?" while rendering managed
   * AGENTS.md guidance, on a code path that must never touch ciphertext and
   * carries only a nullable keyring of its own. Omitting it makes the mutating
   * paths throw rather than silently storing something unreadable.
   */
  keyring?: Keyring | null;
  /** Required for `getForHost`; admin CRUD may construct the service without it. */
  accessLog?: McpAccessLogService;
}

/**
 * null / undefined / '' means "every engine", matching `skills.engine` and
 * `services/host-skills.ts`. A null request engine sees everything.
 */
export function visibleToEngine(
  rowEngine: string | null | undefined,
  engine: Engine | null,
): boolean {
  if (!engine) return true;
  return (
    rowEngine === null || rowEngine === undefined || rowEngine === '' || rowEngine === engine
  );
}

/**
 * Row → DTO. Enumerated rather than spread, and deliberately re-applied on top
 * of `METADATA_COLUMNS`: the unit tier runs on `db-fake`, whose `select(fields)`
 * ignores the field list and hands back whole seeded rows. Picking the fields
 * here too is what makes "no ciphertext in a list response" hold on both tiers
 * rather than only against real MySQL.
 */
function toMetadata(row: {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  engine: string | null;
  tags: unknown;
  createdAt: string;
  updatedAt: string;
  lastRotatedAt: string | null;
  deletedAt: string | null;
}): SecretMetadata {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    engine: isEngine(row.engine) ? row.engine : null,
    tags: sortedLowercase(parseTags(row.tags ?? null)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRotatedAt: row.lastRotatedAt ?? null,
    deletedAt: row.deletedAt ?? null,
  };
}

/**
 * Slug order, applied in process on top of the SQL `ORDER BY`. Both tiers then
 * agree: `db-fake` honours no ordering at all, and MySQL's ordering depends on
 * the column collation. A discovery surface that reshuffles between environments
 * is a discovery surface nobody can write a test against.
 */
const bySlug = (a: SecretMetadata, b: SecretMetadata): number =>
  a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;

/** Substring match over the fields an agent would search by. */
function matchesNeedle(row: SecretMetadata, needle: string): boolean {
  const haystack = [row.slug, row.name, row.description ?? '', row.tags.join(' ')]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

export class SecretsService {
  constructor(private readonly deps: SecretsServiceDeps) {}

  // ── module switch ─────────────────────────────────────────────────────────

  /** Read the `secrets_module_enabled` flag. Absent row means disabled. */
  async getEnabled(): Promise<boolean> {
    const rows = await this.deps.db
      .select()
      .from(versions)
      .where(eq(versions.name, SECRETS_ENABLED_FLAG))
      .limit(1);
    // db-fake ignores WHERE, so re-check the name rather than trusting row 0.
    return rows.find((row) => row.name === SECRETS_ENABLED_FLAG)?.version === '1';
  }

  async adminState(): Promise<SecretsModuleState> {
    const rows = await this.deps.db
      .select()
      .from(versions)
      .where(eq(versions.name, SECRETS_ENABLED_FLAG))
      .limit(1);
    const row = rows.find((candidate) => candidate.name === SECRETS_ENABLED_FLAG);
    return {
      enabled: row?.version === '1',
      updated_at: row?.updatedAt ?? null,
      count: await this.availableCount(null),
    };
  }

  async setEnabled(enabled: boolean): Promise<SecretsModuleState> {
    const now = nowIso();
    const existing = await this.deps.db
      .select()
      .from(versions)
      .where(eq(versions.name, SECRETS_ENABLED_FLAG))
      .limit(1);
    if (existing.find((row) => row.name === SECRETS_ENABLED_FLAG)) {
      await this.deps.db
        .update(versions)
        .set({ version: enabled ? '1' : '0', updatedAt: now })
        .where(eq(versions.name, SECRETS_ENABLED_FLAG));
    } else {
      await this.deps.db
        .insert(versions)
        .values({ name: SECRETS_ENABLED_FLAG, version: enabled ? '1' : '0', updatedAt: now });
    }
    wsPublisher.publish('settings.changed', { kind: 'secrets_module', enabled });
    return await this.adminState();
  }

  /**
   * How many live secrets this engine can see. A diagnostics/capability read:
   * it selects metadata only and never touches the keyring, because the managed
   * AGENTS.md renderer calls it on every host bootstrap.
   */
  async availableCount(engine: Engine | null): Promise<number> {
    const rows = await this.deps.db
      .select({ engine: secrets.engine, deletedAt: secrets.deletedAt })
      .from(secrets)
      .where(isNull(secrets.deletedAt));
    return rows.filter((row) => !row.deletedAt && visibleToEngine(row.engine, engine)).length;
  }

  // ── metadata surface — never decrypts, never selects value_enc ─────────────

  async list(opts: ListOptions = {}): Promise<SecretMetadata[]> {
    const engine = opts.engine ?? null;
    const conditions: SQL[] = [];
    if (!opts.includeDeleted) conditions.push(isNull(secrets.deletedAt));
    if (engine) {
      conditions.push(or(isNull(secrets.engine), eq(secrets.engine, engine)) as SQL);
    }

    const rows = await this.deps.db
      .select(METADATA_COLUMNS)
      .from(secrets)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(secrets.slug));

    // Second, in-process pass over the same two predicates. The SQL above is
    // the half that scales; this is the half that is provable on `db-fake`,
    // whose filter drops to a loose "any column equals any param" fallback the
    // moment a where clause contains `or(...)` — which engine visibility always
    // does. Belt and braces, and the braces are the testable half.
    return rows
      .filter((row) => (opts.includeDeleted ? true : !row.deletedAt))
      .filter((row) => visibleToEngine(row.engine, engine))
      .map(toMetadata)
      .sort(bySlug)
      .slice(0, opts.limit ?? DEFAULT_LIST_LIMIT);
  }

  /**
   * Substring match over slug, name, description and tags. Deliberately not
   * FULLTEXT: this corpus is tens of rows, and MySQL's default
   * `innodb_ft_min_token_size = 3` plus its stopword list would make
   * `secret_search("db")` return nothing with no error — indistinguishable from
   * "no such credential", the worst possible answer from a discovery surface.
   * An empty query degrades to a listing.
   */
  async search(query: string, opts: ListOptions = {}): Promise<SecretMetadata[]> {
    const needle = query.trim().toLowerCase();
    if (needle === '') return this.list({ ...opts, limit: opts.limit ?? DEFAULT_SEARCH_LIMIT });

    // `%` and `_` are LIKE metacharacters; a query of "100%" must not match all.
    const pattern = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const conditions: SQL[] = [isNull(secrets.deletedAt)];
    if (opts.engine) {
      conditions.push(or(isNull(secrets.engine), eq(secrets.engine, opts.engine)) as SQL);
    }
    conditions.push(
      or(
        like(secrets.slug, pattern),
        like(secrets.name, pattern),
        like(secrets.description, pattern),
        like(secrets.tagsText, pattern),
      ) as SQL,
    );

    const rows = await this.deps.db
      .select(METADATA_COLUMNS)
      .from(secrets)
      .where(and(...conditions))
      .orderBy(asc(secrets.slug));

    // Same reasoning as list(): re-apply in process so the fake can prove it.
    return rows
      .filter((row) => !row.deletedAt && visibleToEngine(row.engine, opts.engine ?? null))
      .map(toMetadata)
      .filter((row) => matchesNeedle(row, needle))
      .sort(bySlug)
      .slice(0, opts.limit ?? DEFAULT_SEARCH_LIMIT);
  }

  async findById(id: number, opts: { includeDeleted?: boolean } = {}): Promise<SecretMetadata | null> {
    const rows = await this.deps.db
      .select(METADATA_COLUMNS)
      .from(secrets)
      .where(eq(secrets.id, id))
      .limit(1);
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return null;
    if (!opts.includeDeleted && row.deletedAt) return null;
    return toMetadata(row);
  }

  async findBySlug(slug: string, opts: ListOptions = {}): Promise<SecretMetadata | null> {
    const normalized = this.normalizeSlug(slug);
    const rows = await this.deps.db
      .select(METADATA_COLUMNS)
      .from(secrets)
      .where(eq(secrets.slug, normalized))
      .limit(1);
    const row = rows.find((candidate) => candidate.slug === normalized);
    if (!row) return null;
    if (!opts.includeDeleted && row.deletedAt) return null;
    if (!visibleToEngine(row.engine, opts.engine ?? null)) return null;
    return toMetadata(row);
  }

  // ── host-facing surface: the module switch gates these, not admin CRUD ─────

  async listForHost(engine: Engine | null): Promise<SecretListing[]> {
    if (!(await this.getEnabled())) return [];
    return (await this.list({ engine })).map(toSecretListing);
  }

  async searchForHost(query: string, engine: Engine | null): Promise<SecretListing[]> {
    if (!(await this.getEnabled())) return [];
    return (await this.search(query, { engine })).map(toSecretListing);
  }

  // ── the ONLY two methods that decrypt ─────────────────────────────────────

  /** Admin reveal, behind `requireSecretMutationRole`. */
  async revealById(id: number): Promise<{ secret: SecretMetadata; value: string }> {
    const loaded = await this.loadEnvelope(eq(secrets.id, id), (row) => row.id === id);
    if (!loaded || loaded.deletedAt) {
      throw new NotFoundError('No such secret', 'secret_not_found');
    }
    const value = decryptOrNull(loaded.valueEnc, this.requireKeyring());
    if (value === null) {
      throw new ConflictError(
        'Secret cannot be decrypted with the current keyring',
        'secret_undecryptable',
      );
    }
    return { secret: toMetadata(loaded), value };
  }

  /**
   * The MCP read path. Two properties here are non-negotiable:
   *
   *  1. The audit row is written BEFORE the plaintext is returned, and its
   *     failure propagates. `mcp-server.ts` already logs every `tools/call`, but
   *     with `name = 'secret_get'` (no slug) inside a swallowing `try/catch` —
   *     under that path alone "every secret_get is audited" is simply false.
   *     This row carries the slug and is not swallowed, so a credential is never
   *     handed out without a trail.
   *  2. A miss is audited too, with `success: false`. Probing for slugs is a
   *     signal worth keeping.
   *
   * `clientIp` is null: the tool handler signature is `(args, host, engine)` and
   * carries no request. The generic `tools/call` row written microseconds later
   * by mcp-server.ts has the IP and the same host, so the two correlate.
   */
  async getForHost(slug: string, host: Host, engine: Engine | null): Promise<SecretPayload> {
    const accessLog = this.deps.accessLog;
    if (!accessLog) throw new Error('SecretsService requires accessLog for host reads');

    const normalized = this.normalizeSlug(slug);
    const audit = async (success: boolean, message: string | null): Promise<void> => {
      await accessLog.log({
        hostId: host.id,
        clientIp: null,
        method: 'secret.read',
        name: `secret_get:${normalized}`.slice(0, 128),
        success,
        errorCode: null,
        errorMessage: message,
        engine,
      });
    };

    if (!(await this.getEnabled())) {
      await audit(false, 'secrets_disabled');
      throw new NotFoundError('The fleet secrets store is disabled', 'secrets_disabled');
    }

    const loaded = await this.loadEnvelope(
      eq(secrets.slug, normalized),
      (row) => row.slug === normalized,
    );
    if (!loaded || loaded.deletedAt || !visibleToEngine(loaded.engine, engine)) {
      await audit(false, 'not_found');
      throw new NotFoundError(`No secret with slug '${normalized}'`, 'secret_not_found');
    }

    const value = decryptOrNull(loaded.valueEnc, this.requireKeyring());
    if (value === null) {
      // Envelope present but undecryptable: a rotated-away key. Never fall back
      // to returning the envelope; decryptOrNull's plaintext passthrough only
      // applies to non-envelope legacy rows, which this NOT NULL column never
      // holds.
      await audit(false, 'decrypt_failed');
      throw new ConflictError(
        'Secret cannot be decrypted with the current keyring',
        'secret_undecryptable',
      );
    }

    await audit(true, null); // awaited, unguarded: no trail, no secret.

    const metadata = toMetadata(loaded);
    return {
      slug: metadata.slug,
      name: metadata.name,
      description: metadata.description,
      value,
      engine: metadata.engine,
      tags: metadata.tags,
      last_rotated_at: metadata.lastRotatedAt,
    };
  }

  // ── mutations ─────────────────────────────────────────────────────────────

  async create(input: CreateSecretInput): Promise<SecretMetadata> {
    const slug = this.normalizeSlug(input.slug);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '') throw new ValidationError('name is required', { param: 'name' });
    if (typeof input.value !== 'string' || input.value === '') {
      throw new ValidationError('value is required', { param: 'value' });
    }
    if (input.engine !== null && input.engine !== undefined && !isEngine(input.engine)) {
      throw new ValidationError('engine must be codex or claude', { param: 'engine' });
    }

    // A soft-deleted row still holds the slug (uniq_secrets_slug is on slug
    // alone), so a create against it is a revive-and-rotate rather than a
    // duplicate-key error the operator can do nothing about.
    const priorRows = await this.deps.db
      .select({ id: secrets.id, slug: secrets.slug, deletedAt: secrets.deletedAt })
      .from(secrets)
      .where(eq(secrets.slug, slug))
      .limit(1);
    const prior = priorRows.find((row) => row.slug === slug);
    if (prior && !prior.deletedAt) {
      throw new ConflictError(`A secret with slug '${slug}' already exists`, 'secret_slug_taken');
    }

    const now = nowIso();
    const tags = sortedLowercase(this.normalizeTags(input.tags));
    const values = {
      slug,
      name,
      description: input.description?.trim() || null,
      valueEnc: encryptSecret(input.value, this.requireKeyring()),
      engine: input.engine ?? null,
      tags,
      tagsText: tags.join(' ') || null,
      updatedAt: now,
      lastRotatedAt: now,
      deletedAt: null,
    };

    if (prior) {
      await this.deps.db.update(secrets).set(values).where(eq(secrets.id, prior.id));
      const revived = await this.findById(prior.id);
      if (!revived) throw new Error('Failed to persist secret');
      return revived;
    }

    const result = await this.deps.db.insert(secrets).values({ ...values, createdAt: now });
    const insertId = (result as unknown as [{ insertId?: number }])[0]?.insertId;
    const record =
      typeof insertId === 'number' && insertId > 0
        ? await this.findById(insertId)
        : await this.findBySlug(slug);
    if (!record) throw new Error('Failed to persist secret');
    return record;
  }

  async update(
    id: number,
    input: UpdateSecretInput,
  ): Promise<{ secret: SecretMetadata; rotated: boolean } | null> {
    const loaded = await this.loadEnvelope(eq(secrets.id, id), (row) => row.id === id);
    if (!loaded || loaded.deletedAt) return null;

    const now = nowIso();
    const patch: Record<string, unknown> = { updatedAt: now };
    let rotated = false;

    if (input.value !== undefined) {
      if (typeof input.value !== 'string' || input.value === '') {
        throw new ValidationError('value cannot be empty', { param: 'value' });
      }
      // Decrypt-and-compare rather than a stored digest: `last_rotated_at`
      // should mean "the value actually changed", and a `value_sha256` column
      // that could answer this cheaply would also be offline-crackable. The
      // keyring is already in hand here, so this costs one secretbox open.
      if (decryptOrNull(loaded.valueEnc, this.requireKeyring()) !== input.value) {
        patch['valueEnc'] = encryptSecret(input.value, this.requireKeyring());
        patch['lastRotatedAt'] = now;
        rotated = true;
      }
    }
    if (input.name !== undefined) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name === '') throw new ValidationError('name is required', { param: 'name' });
      patch['name'] = name;
    }
    if (input.description !== undefined) {
      patch['description'] = input.description?.trim() || null;
    }
    if (input.engine !== undefined) {
      if (input.engine !== null && !isEngine(input.engine)) {
        throw new ValidationError('engine must be codex or claude', { param: 'engine' });
      }
      patch['engine'] = input.engine ?? null;
    }
    if (input.tags !== undefined) {
      const tags = sortedLowercase(this.normalizeTags(input.tags));
      patch['tags'] = tags;
      patch['tagsText'] = tags.join(' ') || null;
    }
    // Slug is intentionally immutable: it is the lookup key agents hold, and a
    // rename would silently break every agent that learned it. Delete + create.

    await this.deps.db.update(secrets).set(patch).where(eq(secrets.id, id));
    const secret = await this.findById(id);
    if (!secret) throw new Error('Failed to persist secret');
    return { secret, rotated };
  }

  async softDelete(id: number): Promise<SecretMetadata | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    const now = nowIso();
    await this.deps.db
      .update(secrets)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(secrets.id, id));
    return this.findById(id, { includeDeleted: true });
  }

  // ── private ───────────────────────────────────────────────────────────────

  /**
   * The ONLY place `valueEnc` is selected. Keep the call sites countable: two
   * decrypting methods plus `update`, which needs the old envelope to decide
   * whether the value really changed.
   *
   * `match` re-checks the predicate in process because `db-fake` ignores WHERE.
   */
  private async loadEnvelope(
    where: SQL,
    match: (row: Secret) => boolean,
  ): Promise<Secret | null> {
    const rows = await this.deps.db.select().from(secrets).where(where).limit(1);
    return rows.find(match) ?? null;
  }

  private requireKeyring(): Keyring {
    const keyring = this.deps.keyring;
    if (!keyring) throw new Error('SecretsService requires a keyring to encrypt or decrypt');
    return keyring;
  }

  private normalizeSlug(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ValidationError('slug is required', { param: 'slug' });
    }
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > SLUG_MAX) {
      throw new ValidationError(`slug must be ${SLUG_MAX} characters or fewer`, { param: 'slug' });
    }
    if (!SLUG_RE.test(trimmed)) {
      throw new ValidationError(
        'slug must start with a letter or digit and may only contain lowercase letters, digits, dots, underscores, hyphens, and colons',
        { param: 'slug' },
      );
    }
    return trimmed;
  }

  private normalizeTags(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      throw new ValidationError('tags must be an array of strings', { param: 'tags' });
    }
    const tags: string[] = [];
    for (const tag of value) {
      if (typeof tag !== 'string') {
        throw new ValidationError('tags must be an array of strings', { param: 'tags' });
      }
      const trimmed = tag.trim();
      if (trimmed !== '') tags.push(trimmed);
    }
    if (tags.length > 32) {
      throw new ValidationError('tags must contain 32 entries or fewer', { param: 'tags' });
    }
    return tags;
  }
}

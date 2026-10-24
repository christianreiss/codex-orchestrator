import { mutateOwnerState, ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { adminAudit } from '../control-plane/state/admin.js';
import type { StateRow } from '../control-plane/state/catalog.js';
import type { Json } from '../control-plane/commands.js';
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
import { adminEvents, secrets, versions, type Host, type Secret } from '../db/schema.js';
import type { Keyring } from '../security/keyring.js';
import { encrypt as encryptSecret, decryptOrNull } from '../security/secret-box.js';
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
  sourceHostId: secrets.sourceHostId,
  sourceEngine: secrets.sourceEngine,
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
  /** The host that created it over MCP; null means operator-created. */
  sourceHostId: number | null;
  sourceEngine: Engine | null;
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
  tags: string[];
  last_rotated_at: string | null;
  /** True when the calling host owns this and may rotate or delete it. */
  owned_by_you: boolean;
}

export function toSecretListing(row: SecretMetadata, hostId: number | null): SecretListing {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    tags: row.tags,
    last_rotated_at: row.lastRotatedAt,
    // Spelled out rather than left for the agent to infer from a host id it does
    // not know: the whole point is that it can tell at a glance which entries it
    // may rotate and which belong to an operator.
    owned_by_you: hostId !== null && row.sourceHostId === hostId,
  };
}

/** What `secret_get` hands an agent. The one shape that carries a value. */
export interface SecretPayload {
  slug: string;
  name: string;
  description: string | null;
  value: string;
  tags: string[];
  last_rotated_at: string | null;
}

export interface CreateSecretInput {
  slug: string;
  name: string;
  value: string;
  description?: string | null;
  tags?: string[];
  /** Set only by the MCP path; admin-created secrets stay operator-owned (null). */
  sourceHostId?: number | null;
  sourceEngine?: Engine | null;
}

/** An omitted field is left alone; an explicit `null` clears it. */
export interface UpdateSecretInput {
  name?: string;
  value?: string;
  description?: string | null;
  tags?: string[];
}

export interface ListOptions {
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
   * on, and how many live secrets exist?" while rendering managed
   * AGENTS.md guidance, on a code path that must never touch ciphertext and
   * carries only a nullable keyring of its own. Omitting it makes the mutating
   * paths throw rather than silently storing something unreadable.
   */
  keyring?: Keyring | null;
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
  sourceHostId?: number | null;
  sourceEngine?: string | null;
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
    sourceHostId: row.sourceHostId ?? null,
    sourceEngine: isEngine(row.sourceEngine) ? row.sourceEngine : null,
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
  private snapshot(){const owner=ownerRuntimeFor(this.deps.db);owner?.assertOwner();return owner?.state.snapshot();}

  async getEnabled(): Promise<boolean> {
    const state=this.snapshot();if(state)return state.setting(SECRETS_ENABLED_FLAG)==='1';
    const rows = await this.deps.db
      .select()
      .from(versions)
      .where(eq(versions.name, SECRETS_ENABLED_FLAG))
      .limit(1);
    // db-fake ignores WHERE, so re-check the name rather than trusting row 0.
    return rows.find((row) => row.name === SECRETS_ENABLED_FLAG)?.version === '1';
  }

  async adminState(): Promise<SecretsModuleState> {
    const state=this.snapshot();if(state)return {enabled:state.setting(SECRETS_ENABLED_FLAG)==='1',updated_at:state.settings.get(SECRETS_ENABLED_FLAG)?.updatedAt??null,count:state.table('secrets').all().filter(row=>!row.deletedAt).length};
    const rows = await this.deps.db
      .select()
      .from(versions)
      .where(eq(versions.name, SECRETS_ENABLED_FLAG))
      .limit(1);
    const row = rows.find((candidate) => candidate.name === SECRETS_ENABLED_FLAG);
    return {
      enabled: row?.version === '1',
      updated_at: row?.updatedAt ?? null,
      count: await this.availableCount(),
    };
  }

  async setEnabled(enabled: boolean): Promise<SecretsModuleState> {
    const owner=ownerRuntimeFor(this.deps.db);if(owner){await mutateOwnerState(owner,{kind:'secrets.enabled',payload:{enabled},prepare:ctx=>{const row={name:SECRETS_ENABLED_FLAG,version:enabled?'1':'0',updatedAt:nowIso()};ctx.draft.upsert('versions',row);ctx.write(async tx=>tx.insert(versions).values(row).onDuplicateKeyUpdate({set:{version:row.version,updatedAt:row.updatedAt}}));adminAudit(ctx,'secrets.enabled',{enabled});return null;}});wsPublisher.publish('settings.changed',{kind:'secrets_module',enabled});return this.adminState();}

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
   * How many live secrets exist across the fleet. A diagnostics/capability read:
   * it selects metadata only and never touches the keyring, because the managed
   * AGENTS.md renderer calls it on every host bootstrap.
   */
  async availableCount(): Promise<number> {
    const state=this.snapshot();if(state)return state.table('secrets').all().filter(row=>!row.deletedAt).length;
    const rows = await this.deps.db
      .select({ deletedAt: secrets.deletedAt })
      .from(secrets)
      .where(isNull(secrets.deletedAt));
    return rows.filter((row) => !row.deletedAt).length;
  }

  // ── metadata surface — never decrypts, never selects value_enc ─────────────

  async list(opts: ListOptions = {}): Promise<SecretMetadata[]> {
    const conditions: SQL[] = [];
    if (!opts.includeDeleted) conditions.push(isNull(secrets.deletedAt));

    const rows = this.snapshot()?.table('secrets').all() ?? await this.deps.db
      .select(METADATA_COLUMNS)
      .from(secrets)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(secrets.slug));

    // Re-check deletion for test doubles that do not evaluate SQL predicates.
    return rows
      .filter((row) => (opts.includeDeleted ? true : !row.deletedAt))
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
    conditions.push(
      or(
        like(secrets.slug, pattern),
        like(secrets.name, pattern),
        like(secrets.description, pattern),
        like(secrets.tagsText, pattern),
      ) as SQL,
    );

    const rows = this.snapshot()?.table('secrets').all() ?? await this.deps.db
      .select(METADATA_COLUMNS)
      .from(secrets)
      .where(and(...conditions))
      .orderBy(asc(secrets.slug));

    // Same reasoning as list(): re-apply in process so the fake can prove it.
    return rows
      .filter((row) => !row.deletedAt)
      .map(toMetadata)
      .filter((row) => matchesNeedle(row, needle))
      .sort(bySlug)
      .slice(0, opts.limit ?? DEFAULT_SEARCH_LIMIT);
  }

  async findById(id: number, opts: { includeDeleted?: boolean } = {}): Promise<SecretMetadata | null> {
    const rows = this.snapshot()?.table('secrets').all() ?? await this.deps.db
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
    const rows = this.snapshot()?.table('secrets').all() ?? await this.deps.db
      .select(METADATA_COLUMNS)
      .from(secrets)
      .where(eq(secrets.slug, normalized))
      .limit(1);
    const row = rows.find((candidate) => candidate.slug === normalized);
    if (!row) return null;
    if (!opts.includeDeleted && row.deletedAt) return null;
    return toMetadata(row);
  }

  // ── host-facing surface: the module switch gates these, not admin CRUD ─────

  async listForHost(hostId: number | null = null): Promise<SecretListing[]> {
    if (!(await this.getEnabled())) return [];
    return (await this.list()).map((row) => toSecretListing(row, hostId));
  }

  async searchForHost(
    query: string,
    hostId: number | null = null,
  ): Promise<SecretListing[]> {
    if (!(await this.getEnabled())) return [];
    return (await this.search(query)).map((row) => toSecretListing(row, hostId));
  }

  /**
   * Create or rotate a secret this host owns. The full lifecycle an agent gets
   * over MCP, alongside `deleteForHost`.
   *
   * Ownership is the whole safety property. A slug already owned by another host
   * is refused, and so is one an operator created through the admin API
   * (`sourceHostId === null`) — otherwise any agent that guessed `powerdns-api-key`
   * could silently replace a shared infrastructure credential and every other
   * host would start authenticating with the wrong value. Reading stays open to
   * every host; only writing is narrowed.
   */
  async storeForHost(
    input: CreateSecretInput,
    host: Host,
    engine: Engine | null,
  ): Promise<{ secret: SecretListing; status: 'created' | 'rotated' | 'unchanged' }> {
    if (!(await this.getEnabled())) {
      throw new NotFoundError('The fleet secrets store is disabled', 'secrets_disabled');
    }
    const owner=ownerRuntimeFor(this.deps.db);
    if(owner){let saved:SecretMetadata|undefined,status:'created'|'rotated'|'unchanged'='created';const slug=this.normalizeSlug(input.slug);
      await mutateOwnerState(owner,{kind:'secret.host.store',payload:{slug,hostId:host.id},authorize:state=>{if(state.setting(SECRETS_ENABLED_FLAG)!=='1')throw new NotFoundError('The fleet secrets store is disabled','secrets_disabled');},prepare:async ctx=>{
        const existing=ctx.snapshot.table('secrets').by('slug',slug)[0];if(existing)this.assertOwned(existing,host,slug);
        if(existing&&!existing.deletedAt){const loaded=await this.loadEnvelope(eq(secrets.id,existing.id),row=>row.id===existing.id);if(!loaded)throw new NotFoundError('Secret missing');const patch=await this.buildRotation(loaded,input,engine);saved=toMetadata(stageUpdate(ctx,'secrets',existing.id,patch.values));status=patch.rotated?'rotated':'unchanged';}
        else{const now=nowIso(),values=this.createValues({...input,slug,sourceHostId:host.id,sourceEngine:engine},now);if(existing)saved=toMetadata(stageUpdate(ctx,'secrets',existing.id,values));else ctx.write(async tx=>{const row={...values,createdAt:now},inserted=await tx.insert(secrets).values(row);const next={id:Number(inserted[0].insertId),...row};ctx.draft.upsert('secrets',next);saved=toMetadata(next);});}
        adminAudit(ctx,'secret.stored',()=>({slug,status}),nowIso(),host.id);return ()=>({secret:toSecretListing(saved!,host.id),status}) as unknown as Json;
      }});return {secret:toSecretListing(saved!,host.id),status};
    }
    const slug = this.normalizeSlug(input.slug);
    const existing = await this.loadEnvelope(eq(secrets.slug, slug), (row) => row.slug === slug);

    if (existing && !existing.deletedAt) {
      this.assertOwned(existing, host, slug);
      const patch = await this.buildRotation(existing, input, engine);
      await this.deps.db.update(secrets).set(patch.values).where(eq(secrets.id, existing.id));
      const updated = await this.findById(existing.id);
      if (!updated) throw new Error('Failed to persist secret');
      return {
        secret: toSecretListing(updated, host.id),
        status: patch.rotated ? 'rotated' : 'unchanged',
      };
    }
    if (existing?.deletedAt) {
      // A soft-deleted row still holds the slug. Reviving is a create, so the
      // ownership check still applies — a host must not adopt another host's
      // retired slug and inherit whatever an agent already learned about it.
      this.assertOwned(existing, host, slug);
    }

    const created = await this.create({
      ...input,
      slug,
      sourceHostId: host.id,
      sourceEngine: engine,
    });
    return { secret: toSecretListing(created, host.id), status: 'created' };
  }

  /** Soft-delete a secret this host owns. Takes effect on the next read. */
  async deleteForHost(
    slug: string,
    host: Host,
    _engine: Engine | null,
  ): Promise<{ slug: string; status: 'deleted' }> {
    if (!(await this.getEnabled())) {
      throw new NotFoundError('The fleet secrets store is disabled', 'secrets_disabled');
    }
    const owner=ownerRuntimeFor(this.deps.db);
    if(owner){const normalized=this.normalizeSlug(slug);await mutateOwnerState(owner,{kind:'secret.host.delete',payload:{slug:normalized,hostId:host.id},prepare:ctx=>{if(ctx.snapshot.setting(SECRETS_ENABLED_FLAG)!=='1')throw new NotFoundError('The fleet secrets store is disabled','secrets_disabled');const row=ctx.snapshot.table('secrets').by('slug',normalized)[0];if(!row||row.deletedAt)throw new NotFoundError('Secret not found','secret_not_found');this.assertOwned(row,host,normalized);stageUpdate(ctx,'secrets',row.id,{deletedAt:nowIso(),updatedAt:nowIso()});adminAudit(ctx,'secret.deleted',{slug:normalized},nowIso(),host.id);return null;}});return {slug:normalized,status:'deleted'};}
    const normalized = this.normalizeSlug(slug);
    const existing = await this.loadEnvelope(
      eq(secrets.slug, normalized),
      (row) => row.slug === normalized,
    );
    if (!existing || existing.deletedAt) {
      throw new NotFoundError(`No secret with slug '${normalized}'`, 'secret_not_found');
    }
    this.assertOwned(existing, host, normalized);
    await this.softDelete(existing.id);
    return { slug: normalized, status: 'deleted' };
  }

  /**
   * The ownership gate. Refuses with a message that tells the agent what to do
   * instead, because "forbidden" alone invites a retry loop.
   */
  private assertOwned(row: Pick<Secret,'sourceHostId'>, host: Host, slug: string): void {
    if (row.sourceHostId === host.id) return;
    if (row.sourceHostId === null || row.sourceHostId === undefined) {
      throw new ConflictError(
        `'${slug}' was created by an operator and is read-only here. You can read it with secret_get; ask an operator to change it.`,
        'secret_not_owned',
      );
    }
    throw new ConflictError(
      `'${slug}' belongs to another host and cannot be changed from here. Use a slug of your own.`,
      'secret_not_owned',
    );
  }

  /** Shared by storeForHost: decides whether the value actually changed. */
  private async buildRotation(
    existing: Secret,
    input: CreateSecretInput,
    engine: Engine | null,
  ): Promise<{ values: Record<string, unknown>; rotated: boolean }> {
    const now = nowIso();
    const tags = sortedLowercase(this.normalizeTags(input.tags));
    const values: Record<string, unknown> = {
      name: input.name?.trim() || existing.name,
      description: input.description?.trim() || existing.description || null,
      sourceEngine: engine,
      tags: input.tags === undefined ? existing.tags : tags,
      tagsText: input.tags === undefined ? existing.tagsText : tags.join(' ') || null,
      updatedAt: now,
    };
    let rotated = false;
    if (typeof input.value === 'string' && input.value !== '') {
      if (decryptOrNull(existing.valueEnc, this.requireKeyring()) !== input.value) {
        values['valueEnc'] = encryptSecret(input.value, this.requireKeyring());
        values['lastRotatedAt'] = now;
        rotated = true;
      }
    }
    return { values, rotated };
  }

  // ── the ONLY two methods that decrypt ─────────────────────────────────────

  private async readOwnedSecret(selector:{id?:number;slug?:string},host:Host|null,engine:Engine|null):Promise<{secret:SecretMetadata;value:string}>{
    const owner=ownerRuntimeFor(this.deps.db)!;let revealed:{secret:SecretMetadata;value:string}|undefined,failure:string|null=null;
    await mutateOwnerState(owner,{kind:'secret.read',payload:{...selector,hostId:host?.id??null,engine},prepare:async ctx=>{
      const row=selector.id!==undefined?ctx.snapshot.table('secrets').get(selector.id):ctx.snapshot.table('secrets').by('slug',selector.slug!)[0];
      if(host&&ctx.snapshot.setting(SECRETS_ENABLED_FLAG)!=='1')failure='secrets_disabled';
      else if(!row||row.deletedAt)failure='not_found';
      else{
        const loaded=await this.loadEnvelope(eq(secrets.id,row.id),candidate=>candidate.id===row.id);
        if(!loaded||loaded.deletedAt)throw new Error('Secret envelope disagrees with authoritative metadata');
        const value=decryptOrNull(loaded.valueEnc,this.requireKeyring());
        if(value===null)failure='decrypt_failed';else revealed={secret:toMetadata(row),value};
      }
      adminAudit(ctx,'secret.read',{slug:row?.slug??selector.slug??null,secret_id:row?.id??selector.id??null,success:failure===null,error_code:failure,engine},nowIso(),host?.id??null);
      // No plaintext or encrypted credential is recorded in the command receipt.
      return {audited:true,success:failure===null};
    }});
    if(failure==='decrypt_failed')throw new ConflictError('Secret cannot be decrypted with the current keyring','secret_undecryptable');
    if(failure)throw new NotFoundError(failure==='secrets_disabled'?'The fleet secrets store is disabled':'No such secret',failure==='secrets_disabled'?'secrets_disabled':'secret_not_found');
    if(!revealed)throw new Error('Secret reveal completed without a value');return revealed;
  }

  /** Admin reveal, behind `requireSecretMutationRole`. */
  async revealById(id: number): Promise<{ secret: SecretMetadata; value: string }> {
    if(ownerRuntimeFor(this.deps.db))return this.readOwnedSecret({id},null,null);
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

  /** A credential read (including misses) is audited before plaintext is returned.
   * Audit failure propagates. Only slug, caller and outcome are persisted;
   * ordinary MCP dispatches no longer produce SQL access logs.
   */
  async getForHost(slug: string, host: Host, engine: Engine | null): Promise<SecretPayload> {
    const normalized = this.normalizeSlug(slug);
    if(ownerRuntimeFor(this.deps.db)){const {secret,value}=await this.readOwnedSecret({slug:normalized},host,engine);return {slug:secret.slug,name:secret.name,description:secret.description,value,tags:secret.tags,last_rotated_at:secret.lastRotatedAt};}
    const audit = async (success: boolean, message: string | null): Promise<void> => {
      // No credential leaves the service until its minimal security audit commits.
      await this.deps.db.insert(adminEvents).values({
        type: 'secret.read', hostId: host.id, createdAt: nowIso(),
        payload: { slug: normalized, success, error_code: message, engine },
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
    if (!loaded || loaded.deletedAt) {
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
      tags: metadata.tags,
      last_rotated_at: metadata.lastRotatedAt,
    };
  }

  // ── mutations ─────────────────────────────────────────────────────────────

  private createValues(input:CreateSecretInput,now:string){
    const slug=this.normalizeSlug(input.slug),name=typeof input.name==='string'?input.name.trim():'';
    if(!name)throw new ValidationError('name is required',{param:'name'});if(typeof input.value!=='string'||!input.value)throw new ValidationError('value is required',{param:'value'});
    const tags=sortedLowercase(this.normalizeTags(input.tags));return {slug,name,description:input.description?.trim()||null,valueEnc:encryptSecret(input.value,this.requireKeyring()),sourceHostId:input.sourceHostId??null,sourceEngine:input.sourceEngine??null,tags,tagsText:tags.join(' ')||null,updatedAt:now,lastRotatedAt:now,deletedAt:null};
  }
  async create(input: CreateSecretInput): Promise<SecretMetadata> {
    const owner=ownerRuntimeFor(this.deps.db);if(owner){let saved:SecretMetadata|undefined;const slug=this.normalizeSlug(input.slug);
      await mutateOwnerState(owner,{kind:'secret.create',payload:{slug},prepare:ctx=>{const prior=ctx.snapshot.table('secrets').by('slug',slug)[0];if(prior&&!prior.deletedAt)throw new ConflictError(`A secret with slug '${slug}' already exists`,'secret_slug_taken');const now=nowIso(),values=this.createValues(input,now);
        if(prior)saved=toMetadata(stageUpdate(ctx,'secrets',prior.id,values));else ctx.write(async tx=>{const row={...values,createdAt:now},inserted=await tx.insert(secrets).values(row);const next={id:Number(inserted[0].insertId),...row};ctx.draft.upsert('secrets',next);saved=toMetadata(next);});adminAudit(ctx,'secret.created',{slug});return ()=>saved as unknown as Json;
      }});return saved!;}

    const slug = this.normalizeSlug(input.slug);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '') throw new ValidationError('name is required', { param: 'name' });
    if (typeof input.value !== 'string' || input.value === '') {
      throw new ValidationError('value is required', { param: 'value' });
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
      sourceHostId: input.sourceHostId ?? null,
      sourceEngine: input.sourceEngine ?? null,
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
    const owner=ownerRuntimeFor(this.deps.db),expected=owner?.state.snapshot().table('secrets').get(id);
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
    if (input.tags !== undefined) {
      const tags = sortedLowercase(this.normalizeTags(input.tags));
      patch['tags'] = tags;
      patch['tagsText'] = tags.join(' ') || null;
    }
    // Slug is intentionally immutable: it is the lookup key agents hold, and a
    // rename would silently break every agent that learned it. Delete + create.

    if(owner){await mutateOwnerState(owner,{kind:'secret.update',payload:{id},authorize:state=>{if(state.table('secrets').get(id)!==expected)throw new ConflictError('Secret changed during update','secret_changed');},prepare:ctx=>{stageUpdate(ctx,'secrets',id,patch);adminAudit(ctx,'secret.updated',{id,rotated});return null;}});}else
    await this.deps.db.update(secrets).set(patch).where(eq(secrets.id, id));
    const secret = await this.findById(id);
    if (!secret) throw new Error('Failed to persist secret');
    return { secret, rotated };
  }

  async softDelete(id: number): Promise<SecretMetadata | null> {
    const owner=ownerRuntimeFor(this.deps.db);if(owner){let result:SecretMetadata|null=null;await mutateOwnerState(owner,{kind:'secret.delete',payload:{id},prepare:ctx=>{const row=ctx.snapshot.table('secrets').get(id);if(!row||row.deletedAt)return null;result=toMetadata(stageUpdate(ctx,'secrets',id,{deletedAt:nowIso(),updatedAt:nowIso()}));adminAudit(ctx,'secret.deleted',{id});return result as unknown as Json;}});return result;}

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

import { ownerRuntimeFor, mutateOwnerState, setOwnerRequestPrincipal } from '../control-plane/state/runtime.js';
import { stageUpdate, stageDelete } from '../control-plane/state/rows.js';
import { adminAudit } from '../control-plane/state/admin.js';
import { recordGatewayKeyUse, pendingGatewayKeyUse } from './gateway-key-usage.js';
import { UnauthorizedError } from '../http/errors.js';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { openaiApiKeys, type OpenaiApiKey } from '../db/schema.js';
import { Keyring } from '../security/keyring.js';
import { encrypt as encryptSecret } from '../security/secret-box.js';
import { sha256 } from '../security/hash.js';
import { nowIso } from '../util/timestamp.js';
import { ENGINE_CODEX, type Engine } from '../util/engine.js';

/**
 * Service for the `openai_api_keys` table. Owns issuance, validation, and
 * mutation of bearer keys used by the `/v1/*` OpenAI-compat endpoints. The key
 * layout (`sk-cdx-<64-hex>`) is engine-scoped via the `engine` column so the
 * Claude worktree can reuse the same table with a different prefix.
 */

export const OPENAI_KEY_PREFIX = 'sk-cdx-';

export interface IssuedKey {
  key: string; // returned once; never persisted in plaintext
  record: OpenaiApiKey;
}

export interface CreateKeyInput {
  name: string;
  adminUserId?: number | null;
  expiresAt?: string | null;
  engine?: Engine;
  backendEngine?: Engine | null;
  prefix?: string;
}

export interface OpenAiKeyServiceDeps {
  db: Database;
  keyring: Keyring;
}

export class OpenAiKeyService {
  constructor(private readonly deps: OpenAiKeyServiceDeps) {}

  /**
   * Issue a fresh API key. The raw value is returned exactly once; only its
   * sha256 hash and an `sbox:v1` envelope copy are stored.
   */
  async issue(input: CreateKeyInput): Promise<IssuedKey> {
    const name = input.name.trim();
    if (name === '') {
      throw new Error('name is required');
    }
    const engine: Engine = input.engine ?? ENGINE_CODEX;

    const raw = randomBytes(32).toString('hex');
    const key = `${input.prefix ?? ({ codex: OPENAI_KEY_PREFIX, claude: 'sk-ant-', grok: 'sk-cgx-' } satisfies Record<Engine, string>)[engine]}${raw}`;
    const keyHash = sha256(key);
    const keyEnc = encryptSecret(key, this.deps.keyring);
    const prefix = `${key.slice(0, 16)}...`;
    const now = nowIso();

    const owner=ownerRuntimeFor(this.deps.db);
    if(owner){
      return await mutateOwnerState(owner,{kind:'gateway.key.issue',payload:{name,engine,backendEngine:input.backendEngine??null,keyHash,expiresAt:input.expiresAt??null},prepare(ctx){
        let record:OpenaiApiKey;const row={name,keyPrefix:prefix,keyHash,keyEnc,adminUserId:input.adminUserId??null,isActive:1,useCount:0,lastUsedAt:null,expiresAt:input.expiresAt??null,engine,backendEngine:input.backendEngine??null,createdAt:now,updatedAt:now};
        ctx.write(async tx=>{const [inserted]=await tx.insert(openaiApiKeys).values(row);record={...row,id:Number(inserted.insertId)};ctx.draft.upsert('openaiApiKeys',record);});adminAudit(ctx,'gateway.key.issued',()=>({key_id:record.id,name,engine}));return ()=>({key,record});
      }}) as unknown as IssuedKey;
    }
    const result = await this.deps.db.insert(openaiApiKeys).values({
      name,
      keyPrefix: prefix,
      keyHash,
      keyEnc,
      adminUserId: input.adminUserId ?? null,
      isActive: 1,
      useCount: 0,
      expiresAt: input.expiresAt ?? null,
      engine,
      backendEngine: input.backendEngine ?? null,
      createdAt: now,
      updatedAt: now,
    });

    // Drizzle's mysql2 insert returns a header-like object; the auto-incremented
    // id is on `insertId`. We re-select to return the full row to callers.
    const insertId = (result as unknown as [{ insertId?: number }])[0]?.insertId;
    let record: OpenaiApiKey | undefined;
    if (typeof insertId === 'number' && insertId > 0) {
      record = await this.findById(insertId);
    }
    if (!record) {
      // Fallback: look up by hash (unique)
      const rows = await this.deps.db
        .select()
        .from(openaiApiKeys)
        .where(eq(openaiApiKeys.keyHash, keyHash))
        .limit(1);
      record = rows[0];
    }
    if (!record) {
      throw new Error('Failed to persist API key');
    }
    return { key, record };
  }

  async findById(id: number): Promise<OpenaiApiKey | undefined> {
    const owner=ownerRuntimeFor(this.deps.db);if(owner){owner.assertOwner();const row=owner.state.snapshot().table('openaiApiKeys').get(id),usage=pendingGatewayKeyUse(owner,id);return row?{...row,keyEnc:null,useCount:row.useCount+(usage?.count??0),lastUsedAt:usage?.at??row.lastUsedAt}:undefined;}
    const rows = await this.deps.db
      .select()
      .from(openaiApiKeys)
      .where(eq(openaiApiKeys.id, id))
      .limit(1);
    return rows[0];
  }

  /**
   * Resolve a bearer token to its key record. Returns null when the key is
   * unknown, disabled, expired, or scoped to a different engine.
   */
  async findActiveByBearer(
    bearerToken: string,
    engine: Engine = ENGINE_CODEX,
  ): Promise<OpenaiApiKey | null> {
    if (!bearerToken) return null;
    const hash = sha256(bearerToken);
    const owner=ownerRuntimeFor(this.deps.db);if(owner){owner.assertOwner();const row=owner.state.snapshot().table('openaiApiKeys').by('keyHash',hash).find(row=>row.engine===engine);
      if(!row||row.isActive!==1||row.expiresAt&&Date.parse(row.expiresAt)<=Date.now())return null;
      setOwnerRequestPrincipal({principal:`gateway-key:${row.id}`,revalidate(snapshot){const key=snapshot.table('openaiApiKeys').get(row.id);if(!key||key.keyHash!==hash||key.engine!==engine||key.backendEngine!==row.backendEngine||key.isActive!==1||key.expiresAt&&Date.parse(key.expiresAt)<=Date.now())throw new UnauthorizedError('Gateway key authority changed');}});
      return {...row,keyEnc:null};
    }
    const now = nowIso();
    const rows = await this.deps.db
      .select()
      .from(openaiApiKeys)
      .where(
        and(
          eq(openaiApiKeys.keyHash, hash),
          eq(openaiApiKeys.engine, engine),
          eq(openaiApiKeys.isActive, 1),
          or(isNull(openaiApiKeys.expiresAt), gt(openaiApiKeys.expiresAt, now)),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Record one use of a key. Increments `use_count`, refreshes `last_used_at`
   * and `updated_at`. Failures are silent — bumping the counter is best-effort.
   */
  async touch(id: number): Promise<void> {
    if(ownerRuntimeFor(this.deps.db)){recordGatewayKeyUse(this.deps.db,id);return;}
    const now = nowIso();
    try {
      // Drizzle MySQL doesn't support a clean column-arithmetic helper here;
      // Read-then-write under a small race window is sufficient because the
      // usage counter is approximate by design.
      const rows = await this.deps.db
        .select({ useCount: openaiApiKeys.useCount })
        .from(openaiApiKeys)
        .where(eq(openaiApiKeys.id, id))
        .limit(1);
      const next = (rows[0]?.useCount ?? 0) + 1;
      await this.deps.db
        .update(openaiApiKeys)
        .set({ useCount: next, lastUsedAt: now, updatedAt: now })
        .where(eq(openaiApiKeys.id, id));
    } catch {
      /* non-fatal */
    }
  }

  /** Engine-scoped listing for the admin UI (no encrypted blobs). */
  async listByEngine(engine: Engine): Promise<Array<Omit<OpenaiApiKey, 'keyHash' | 'keyEnc'>>> {
    const owner=ownerRuntimeFor(this.deps.db);if(owner){owner.assertOwner();return [...owner.state.snapshot().table('openaiApiKeys').by('engine',engine)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(({keyHash:_,...row})=>{const usage=pendingGatewayKeyUse(owner,row.id);return {...row,useCount:row.useCount+(usage?.count??0),lastUsedAt:usage?.at??row.lastUsedAt};});}
    const rows = await this.deps.db
      .select({
        id: openaiApiKeys.id,
        name: openaiApiKeys.name,
        keyPrefix: openaiApiKeys.keyPrefix,
        adminUserId: openaiApiKeys.adminUserId,
        isActive: openaiApiKeys.isActive,
        useCount: openaiApiKeys.useCount,
        lastUsedAt: openaiApiKeys.lastUsedAt,
        expiresAt: openaiApiKeys.expiresAt,
        engine: openaiApiKeys.engine,
        backendEngine: openaiApiKeys.backendEngine,
        createdAt: openaiApiKeys.createdAt,
        updatedAt: openaiApiKeys.updatedAt,
      })
      .from(openaiApiKeys)
      .where(eq(openaiApiKeys.engine, engine))
      .orderBy(desc(openaiApiKeys.createdAt));
    return rows;
  }

  /**
   * Toggle a key's active state, scoped to `engine` so a codex-admin request
   * can't mutate (or silently no-op on) a claude-owned row that happens to
   * share the same auto-increment id. Returns null when no row matched the
   * (id, engine) pair so callers can surface a 404.
   */
  async setActive(
    id: number,
    active: boolean,
    engine: Engine = ENGINE_CODEX,
  ): Promise<OpenaiApiKey | null> {
    const owner=ownerRuntimeFor(this.deps.db);
    if(owner)return await mutateOwnerState(owner,{kind:'gateway.key.active',payload:{id,active,engine},prepare(ctx){const row=ctx.snapshot.table('openaiApiKeys').get(id);if(!row||row.engine!==engine)return null;const next=stageUpdate(ctx,'openaiApiKeys',id,{isActive:active?1:0,updatedAt:nowIso()});adminAudit(ctx,'gateway.key.active',{key_id:id,active,engine});return {...next,keyEnc:null};}}) as unknown as OpenaiApiKey|null;
    const existing = await this.findByIdAndEngine(id, engine);
    if (!existing) return null;
    await this.deps.db
      .update(openaiApiKeys)
      .set({ isActive: active ? 1 : 0, updatedAt: nowIso() })
      .where(and(eq(openaiApiKeys.id, id), eq(openaiApiKeys.engine, engine)));
    return this.findByIdAndEngine(id, engine);
  }

  /**
   * Delete a key, scoped to `engine` for the same reason as `setActive`.
   * Returns false when no row matched the (id, engine) pair.
   */
  async delete(id: number, engine: Engine = ENGINE_CODEX): Promise<boolean> {
    const owner=ownerRuntimeFor(this.deps.db);
    if(owner)return await mutateOwnerState(owner,{kind:'gateway.key.delete',payload:{id,engine},prepare(ctx){const row=ctx.snapshot.table('openaiApiKeys').get(id);if(!row||row.engine!==engine)return false;stageDelete(ctx,'openaiApiKeys',id);adminAudit(ctx,'gateway.key.deleted',{key_id:id,engine});return true;}}) as boolean;
    const existing = await this.findByIdAndEngine(id, engine);
    if (!existing) return false;
    await this.deps.db
      .delete(openaiApiKeys)
      .where(and(eq(openaiApiKeys.id, id), eq(openaiApiKeys.engine, engine)));
    return true;
  }

  private async findByIdAndEngine(id: number, engine: Engine): Promise<OpenaiApiKey | null> {
    const rows = await this.deps.db
      .select()
      .from(openaiApiKeys)
      .where(and(eq(openaiApiKeys.id, id), eq(openaiApiKeys.engine, engine)))
      .limit(1);
    return rows[0] ?? null;
  }
}

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
  rateLimitRpm?: number;
  expiresAt?: string | null;
  engine?: Engine;
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
    const rateLimitRpm =
      typeof input.rateLimitRpm === 'number' && input.rateLimitRpm > 0
        ? Math.floor(input.rateLimitRpm)
        : 60;
    const engine: Engine = input.engine ?? ENGINE_CODEX;

    const raw = randomBytes(32).toString('hex');
    const key = `${OPENAI_KEY_PREFIX}${raw}`;
    const keyHash = sha256(key);
    const keyEnc = encryptSecret(key, this.deps.keyring);
    const prefix = `${key.slice(0, 16)}...`;
    const now = nowIso();

    const result = await this.deps.db.insert(openaiApiKeys).values({
      name,
      keyPrefix: prefix,
      keyHash,
      keyEnc,
      adminUserId: input.adminUserId ?? null,
      rateLimitRpm,
      isActive: 1,
      useCount: 0,
      expiresAt: input.expiresAt ?? null,
      engine,
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
    const now = nowIso();
    try {
      // Drizzle MySQL doesn't support a clean column-arithmetic helper here;
      // read-then-write under a small race window matches the rate-limit
      // plugin's strategy. The counter is approximate by design.
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
    const rows = await this.deps.db
      .select({
        id: openaiApiKeys.id,
        name: openaiApiKeys.name,
        keyPrefix: openaiApiKeys.keyPrefix,
        adminUserId: openaiApiKeys.adminUserId,
        rateLimitRpm: openaiApiKeys.rateLimitRpm,
        isActive: openaiApiKeys.isActive,
        useCount: openaiApiKeys.useCount,
        lastUsedAt: openaiApiKeys.lastUsedAt,
        expiresAt: openaiApiKeys.expiresAt,
        engine: openaiApiKeys.engine,
        createdAt: openaiApiKeys.createdAt,
        updatedAt: openaiApiKeys.updatedAt,
      })
      .from(openaiApiKeys)
      .where(eq(openaiApiKeys.engine, engine))
      .orderBy(desc(openaiApiKeys.createdAt));
    return rows;
  }

  async setActive(id: number, active: boolean): Promise<void> {
    await this.deps.db
      .update(openaiApiKeys)
      .set({ isActive: active ? 1 : 0, updatedAt: nowIso() })
      .where(eq(openaiApiKeys.id, id));
  }

  async delete(id: number): Promise<void> {
    await this.deps.db.delete(openaiApiKeys).where(eq(openaiApiKeys.id, id));
  }
}

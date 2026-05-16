/**
 * Admin CRUD for Anthropic-compatible API keys. Backed by the same
 * `openai_api_keys` table the OpenAI side uses; differentiated by
 * `engine = 'claude'`.
 *
 * Key issuance prefix is `sk-ant-` to match Anthropic's public-API key prefix
 * (the runner and SDK both accept this form).
 */
import { eq, and, desc } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { openaiApiKeys } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { encrypt as encryptSecret } from '../security/secret-box.js';
import { sha256 } from '../security/hash.js';
import { nowIso } from '../util/timestamp.js';

export const CLAUDE_ENGINE = 'claude' as const;
export const CLAUDE_KEY_PREFIX = 'sk-ant-' as const;

export interface ClaudeKeyRecord {
  id: number;
  name: string;
  key_prefix: string;
  admin_user_id: number | null;
  rate_limit_rpm: number;
  is_active: boolean;
  use_count: number;
  last_used_at: string | null;
  expires_at: string | null;
  engine: 'claude';
  created_at: string;
  updated_at: string;
}

export interface ClaudeKeyCreate {
  name: string;
  adminUserId?: number | null;
  rateLimitRpm?: number;
  expiresAt?: string | null;
  prefix?: string;
}

export interface ClaudeKeyIssued {
  key: string; // shown once
  record: ClaudeKeyRecord;
}

export interface ClaudeKeysService {
  list(): Promise<ClaudeKeyRecord[]>;
  create(params: ClaudeKeyCreate): Promise<ClaudeKeyIssued>;
  setActive(id: number, active: boolean): Promise<ClaudeKeyRecord | null>;
  delete(id: number): Promise<boolean>;
  /** For tests / debugging. */
  findById(id: number): Promise<ClaudeKeyRecord | null>;
}

function toRecord(row: typeof openaiApiKeys.$inferSelect): ClaudeKeyRecord {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.keyPrefix,
    admin_user_id: row.adminUserId ?? null,
    rate_limit_rpm: row.rateLimitRpm,
    is_active: row.isActive === 1,
    use_count: row.useCount,
    last_used_at: row.lastUsedAt ?? null,
    expires_at: row.expiresAt ?? null,
    engine: 'claude',
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function createClaudeKeysService(db: Database, keyring: Keyring): ClaudeKeysService {
  async function load(id: number): Promise<ClaudeKeyRecord | null> {
    const rows = await db
      .select()
      .from(openaiApiKeys)
      .where(and(eq(openaiApiKeys.id, id), eq(openaiApiKeys.engine, CLAUDE_ENGINE)))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  return {
    async list() {
      const rows = await db
        .select()
        .from(openaiApiKeys)
        .where(eq(openaiApiKeys.engine, CLAUDE_ENGINE))
        .orderBy(desc(openaiApiKeys.createdAt));
      return rows.map(toRecord);
    },

    async findById(id) {
      return load(id);
    },

    async create({ name, adminUserId, rateLimitRpm, expiresAt, prefix }) {
      const cleanName = name.trim();
      if (!cleanName) throw new Error('name is required');
      const rpm = rateLimitRpm && rateLimitRpm > 0 ? Math.floor(rateLimitRpm) : 60;
      const exp = expiresAt && expiresAt.trim() !== '' ? expiresAt.trim() : null;
      const keyPrefix = prefix ?? CLAUDE_KEY_PREFIX;
      const tail = randomBytes(32).toString('hex');
      const fullKey = `${keyPrefix}${tail}`;
      const keyHash = sha256(fullKey);
      const keyEnc = encryptSecret(fullKey, keyring);
      const displayPrefix = fullKey.slice(0, 16) + '...';
      const now = nowIso();

      await db.insert(openaiApiKeys).values({
        name: cleanName,
        keyPrefix: displayPrefix,
        keyHash,
        keyEnc,
        adminUserId: adminUserId ?? null,
        rateLimitRpm: rpm,
        isActive: 1,
        useCount: 0,
        expiresAt: exp,
        engine: CLAUDE_ENGINE,
        createdAt: now,
        updatedAt: now,
      });

      // Read back the row by hash (unique). Drizzle MySQL has no returning().
      const rows = await db
        .select()
        .from(openaiApiKeys)
        .where(eq(openaiApiKeys.keyHash, keyHash))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error('Failed to read back inserted Claude API key');

      return { key: fullKey, record: toRecord(row) };
    },

    async setActive(id, active) {
      const existing = await load(id);
      if (!existing) return null;
      await db
        .update(openaiApiKeys)
        .set({ isActive: active ? 1 : 0, updatedAt: nowIso() })
        .where(and(eq(openaiApiKeys.id, id), eq(openaiApiKeys.engine, CLAUDE_ENGINE)));
      return load(id);
    },

    async delete(id) {
      const existing = await load(id);
      if (!existing) return false;
      await db
        .delete(openaiApiKeys)
        .where(and(eq(openaiApiKeys.id, id), eq(openaiApiKeys.engine, CLAUDE_ENGINE)));
      return true;
    },
  };
}

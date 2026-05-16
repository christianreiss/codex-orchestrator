import { eq } from 'drizzle-orm';
import { openaiApiKeys, type OpenaiApiKey } from '../../../src/db/schema.js';
import { sha256 } from '../../../src/security/hash.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { nowIso } from '../../../src/util/timestamp.js';
import { testKeyring } from '../test-keyring.js';
import { randomBytes } from 'node:crypto';
import type { TestDb } from '../test-db.js';

export interface MakeOpenaiApiKeyOverrides {
  name?: string;
  /** Full plaintext key; one will be generated when omitted. */
  key?: string;
  /** 'codex' (OpenAI proxy) or 'claude' (Anthropic proxy). */
  engine?: 'codex' | 'claude';
  adminUserId?: number;
  rateLimitRpm?: number;
  isActive?: 0 | 1;
  expiresAt?: string | null;
}

export interface MakeOpenaiApiKeyResult {
  row: OpenaiApiKey;
  key: string;
}

export async function makeOpenaiApiKey(
  db: TestDb,
  overrides: MakeOpenaiApiKeyOverrides = {},
): Promise<MakeOpenaiApiKeyResult> {
  const engine = overrides.engine ?? 'codex';
  const prefix = engine === 'claude' ? 'sk-ant-' : 'sk-';
  const key = overrides.key ?? `${prefix}${randomBytes(24).toString('hex')}`;
  const keyHash = sha256(key);
  const keyEnc = encrypt(key, testKeyring());
  const now = nowIso();

  await db.insert(openaiApiKeys).values({
    name: overrides.name ?? `key-${key.slice(-8)}`,
    keyPrefix: key.slice(0, Math.min(8, key.length)),
    keyHash,
    keyEnc,
    adminUserId: overrides.adminUserId ?? null,
    rateLimitRpm: overrides.rateLimitRpm ?? 60,
    isActive: overrides.isActive ?? 1,
    useCount: 0,
    expiresAt: overrides.expiresAt ?? null,
    createdAt: now,
    updatedAt: now,
    engine,
  });

  const [row] = await db
    .select()
    .from(openaiApiKeys)
    .where(eq(openaiApiKeys.keyHash, keyHash))
    .limit(1);
  if (!row) throw new Error('makeOpenaiApiKey: row not found after insert');
  return { row, key };
}

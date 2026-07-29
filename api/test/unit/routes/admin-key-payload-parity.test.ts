/**
 * `/admin/openai/keys` and `/admin/claude/keys` are two halves of one admin
 * surface over the same `openai_api_keys` table, and the frontend consumes both
 * through a single `ApiKey` type. Their mappers live in different modules
 * (`toAdminApiKey` here, `toRecord` in services/claude-keys.ts), so nothing but
 * this test stops one from renaming a field or changing a JSON type without the
 * other -- which is how `is_active` came to be a tinyint on one side and a
 * boolean on the other.
 */
import { describe, expect, it } from 'vitest';
import { createDbFake } from '../../helpers/db-fake.js';
import { openaiApiKeys } from '../../../src/db/schema.js';
import { toAdminApiKey } from '../../../src/routes/admin/keys/openai.js';
import { createClaudeKeysService } from '../../../src/services/claude-keys.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import type { Database } from '../../../src/db/client.js';

const keyring = testKeyring();

/**
 * Every nullable column carries a value so the `typeof` comparison is about the
 * mappers rather than about two nulls agreeing.
 */
const sharedRow = {
  id: 11,
  name: 'parity',
  keyPrefix: 'sk-xxx-123456789...',
  adminUserId: 3,
  rateLimitRpm: 90,
  useCount: 5,
  lastUsedAt: '2026-07-20T10:30:00Z',
  expiresAt: '2027-01-01T00:00:00Z',
  createdAt: '2026-07-20T10:00:00Z',
  updatedAt: '2026-07-20T10:30:00Z',
};

/** Drives the real claude service over the same row via `createDbFake`. */
async function claudeRecord(isActive: number) {
  const db = createDbFake();
  db.tables.set(openaiApiKeys, [
    { ...sharedRow, isActive, keyHash: 'seed-hash', keyEnc: null, engine: 'claude' },
  ]);
  const record = await createClaudeKeysService(db as unknown as Database, keyring).findById(
    sharedRow.id,
  );
  if (!record) throw new Error('seeded claude key was not readable');
  return record;
}

function jsonTypes(record: object): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, typeof value]));
}

describe('admin key payload parity', () => {
  it.each([1, 0])(
    'serves the same fields with the same JSON types on both engines (isActive %i)',
    async (isActive) => {
      const openai = toAdminApiKey({ ...sharedRow, isActive, engine: 'codex' });
      const claude = await claudeRecord(isActive);

      expect(Object.keys(openai).sort()).toEqual(Object.keys(claude).sort());
      expect(jsonTypes(openai)).toEqual(jsonTypes(claude));

      // The field that actually drifted, asserted on both sides so a mapper
      // that emits `true` for a 0 tinyint still fails.
      expect(openai.is_active).toBe(isActive === 1);
      expect(claude.is_active).toBe(isActive === 1);
    },
  );
});

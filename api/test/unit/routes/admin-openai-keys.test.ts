import { describe, expect, it } from 'vitest';
import { toAdminApiKey } from '../../../src/routes/admin/keys/openai.js';

describe('admin OpenAI key wire shape', () => {
  it('keeps the legacy snake_case fields used by the admin UI', () => {
    const row = toAdminApiKey({
      id: 7,
      name: 'ci',
      keyPrefix: 'sk-cdx-123...',
      adminUserId: 2,
      rateLimitRpm: 120,
      isActive: 1,
      useCount: 42,
      lastUsedAt: '2026-05-20T10:30:00Z',
      expiresAt: null,
      engine: 'codex',
      createdAt: '2026-05-20T10:00:00Z',
      updatedAt: '2026-05-20T10:30:00Z',
    });

    expect(row).toEqual({
      id: 7,
      name: 'ci',
      key_prefix: 'sk-cdx-123...',
      admin_user_id: 2,
      rate_limit_rpm: 120,
      is_active: true,
      use_count: 42,
      last_used_at: '2026-05-20T10:30:00Z',
      expires_at: null,
      engine: 'codex',
      created_at: '2026-05-20T10:00:00Z',
      updated_at: '2026-05-20T10:30:00Z',
    });
    expect('keyPrefix' in row).toBe(false);
    expect('useCount' in row).toBe(false);
  });
});

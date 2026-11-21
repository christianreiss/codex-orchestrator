import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { enumList } from '../../../src/util/enum-list.js';
import { grantSchema, policySchema } from '../../../src/services/connectors/policy.js';
import { feedbackId } from '../../../src/services/feedback-contract.js';
import { wireUtcDateTime, wireOffsetDateTime } from '../../../src/util/wire-datetime.js';

describe('persisted wire formats and collection bounds', () => {
  it('preserves GUID grammar across imported, generated and pre-versioned IDs', () => {
    for (const value of ['00000000-0000-0000-0000-000000000000', '12345678-abcd-0000-0000-abcdefabcdef', '12345678-abcd-4bcd-9abc-abcdefabcdef'])
      expect(feedbackId(value)).toBe(value);
    expect(() => feedbackId('not-an-id')).toThrow();
  });

  it('preserves timestamp bytes, optional seconds and historic offset formats', () => {
    for (const value of ['2024-02-29T23:59Z', '2026-01-01T00:00:55.123456789Z']) {
      expect(wireUtcDateTime.parse(value)).toBe(value);
      expect(wireOffsetDateTime.parse(value)).toBe(value);
    }
    for (const value of ['2024-02-29T23:59+0130', '2024-02-29T23:59:00+01:30']) {
      expect(wireUtcDateTime.safeParse(value).success).toBe(false);
      expect(wireOffsetDateTime.parse(value)).toBe(value);
    }
    for (const value of ['2025-02-29T12:00Z', '2024-02-29T24:00Z', '2024-02-29T12:60Z', '2024-02-29T12:00'])
      expect(wireOffsetDateTime.safeParse(value).success).toBe(false);
  });

  it('keeps restricted connector grants partial and missing ceilings closed', () => {
    const grant = grantSchema.parse({ categories: { workflows: 'ro' } });
    expect(grant.categories).toEqual({ workflows: 'ro' });
    expect(policySchema.parse({}).ceiling).toEqual(grantSchema.parse({}));
  });

  it('bounds invalid enum lists while accepting repeated protocol-set members', () => {
    const grants = enumList(['code', 'refresh']);
    expect(grants.parse(['refresh', 'code', 'refresh', 'code'])).toEqual(['refresh', 'code']);
    expect(grants.safeParse(Array(12).fill('unknown')).error?.issues).toHaveLength(1);
  });

  it('rejects oversized collections before starting per-element validation', () => {
    let visited = 0;
    const item = z.string().refine(() => { visited++; return false; });
    const result = z.array(item).max(4).safeParse(Array(8).fill('fixture'));
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
    expect(visited).toBe(0);
  });
});

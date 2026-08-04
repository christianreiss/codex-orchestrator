import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (path.endsWith('/db/migrations')) continue;
      out.push(...sourceFiles(path));
    } else if (/\.(?:ts|svelte|sql)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe('local request rate limiters stay removed', () => {
  it('has no limiter implementation or auth-failure tracker module', () => {
    expect(existsSync(resolve(ROOT, 'api/src/http/plugins/rate-limit.ts'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'api/src/services/auth-failure-tracker.ts'))).toBe(false);
  });

  it('has no limiter identifiers in executable API or frontend source', () => {
    const files = [
      ...sourceFiles(resolve(ROOT, 'api/src')),
      ...sourceFiles(resolve(ROOT, 'frontend/src')),
    ];
    const forbidden = [
      /\brateLimiter\b/,
      /\bRateLimiter\b/,
      /\bRateLimitedError\b/,
      /\brateLimitRpm\b/,
      /\brate_limit_rpm\b/,
      /\bRATE_LIMIT_[A-Z0-9_]+\b/,
      /\bip_rate_limits\b/,
      /auth-failure-tracker/,
    ];
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return forbidden
        .filter((pattern) => pattern.test(text))
        .map((pattern) => `${file.slice(ROOT.length + 1)} matches ${pattern}`);
    });
    expect(hits).toEqual([]);
  });

  it('ships the destructive cleanup migration', () => {
    const migration = readFileSync(
      resolve(ROOT, 'api/src/db/migrations/0019_remove_rate_limiters.sql'),
      'utf8',
    );
    expect(migration).toContain('DROP TABLE IF EXISTS ip_rate_limits');
    expect(migration).toContain("drop_rate_limit_column('openai_api_keys', 'rate_limit_rpm')");
  });
});

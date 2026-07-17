import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import { runBootChecks } from '../../../src/ops/boot-checks.js';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';

const env = {
  ENCRYPTION_ACTIVE_KEY: Buffer.alloc(32, 7).toString('base64'),
} as Env;

function renderedSql(query: SQL): string {
  return new MySqlDialect().sqlToQuery(query).sql;
}

describe('boot database checks', () => {
  it('probes the required Claude artifact table before optional boot work', async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await runBootChecks(env, { execute } as unknown as Database);

    expect(execute.mock.calls.map(([query]) => renderedSql(query as SQL))).toEqual([
      'SELECT 1',
      'SELECT 1 FROM claude_artifacts LIMIT 0',
    ]);
  });

  it('fails startup when the required Claude artifact table is missing', async () => {
    const missing = new Error("Table 'codex_auth.claude_artifacts' doesn't exist");
    const execute = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(missing);

    await expect(runBootChecks(env, { execute } as unknown as Database)).rejects.toBe(missing);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

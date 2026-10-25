import { describe, expect, it } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { coldClock } from '../../../src/services/server-retention/cold.js';
import { DEFAULT_SERVER_RETENTION } from '../../../src/services/server-retention/policy.js';
import { RetentionDeadlineIndex } from '../../../src/services/server-retention/deadlines.js';

const policy = { ...DEFAULT_SERVER_RETENTION, armed: true };
const now = Date.parse('2026-10-25T00:00:00Z');
const valid = '2026-10-12T00:00:00.000Z';
const invalid = '2026-10-11T99:00:00Z';
function fixture(stamps: string[]) {
  const dialect = new MySqlDialect();
  const queries: { sql: string; params: unknown[] }[] = [];
  const tx = {
    async execute(statement: SQL) {
      const query = dialect.sqlToQuery(statement);
      queries.push(query);
      const cursor = query.params[0] as string;
      const limit = /LIMIT (\d+)/.exec(query.sql)?.[1];
      const size = limit ? Number(limit) : Number(query.params.at(-1));
      const rows = stamps
        .filter((at) => (query.sql.includes('<=?') ? at <= cursor : at > cursor))
        .sort()
        .slice(0, size)
        .map((at) => ({ at }));
      return [rows];
    },
  } as unknown as PersistenceTransaction;
  return { tx, queries };
}

describe('invalid legacy cold-clock timestamps', () => {
  it('finds a valid successor behind a regex-valid but unparsable timestamp', async () => {
    const f = fixture([invalid, valid]);
    expect(await coldClock(f.tx, 'auditlogs', now, policy)).toEqual({
      past: false,
      next: Date.parse(valid) + policy.audit_days * 86_400_000,
    });
    expect(f.queries).toHaveLength(3);
  });
  it('seeks over duplicate invalid timestamps rather than paging by offset', async () => {
    const f = fixture([...Array<string>(200).fill(invalid), valid]);
    expect((await coldClock(f.tx, 'auditlogs', now, policy)).next).toBe(
      Date.parse(valid) + policy.audit_days * 86_400_000,
    );
    expect(f.queries).toHaveLength(3);
    expect(f.queries[2]!.params).toContain(invalid);
    expect(f.queries.every((query) => !/OFFSET|DATE\(|CAST\(/i.test(query.sql))).toBe(true);
  });
  it('walks multiple bounded invalid pages without losing the later deadline', async () => {
    const stamps = Array.from(
      { length: 150 },
      (_, n) =>
        `2026-10-11T99:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z`,
    );
    const f = fixture([...stamps, valid]);
    expect((await coldClock(f.tx, 'auditlogs', now, policy)).next).toBe(
      Date.parse(valid) + policy.audit_days * 86_400_000,
    );
    expect(f.queries.length).toBeGreaterThan(3);
    expect(f.queries.length).toBeLessThan(10);
  });
  it('parks invalid-only history without arming an empty polling obligation', async () => {
    const f = fixture([invalid, invalid]);
    const index = new RetentionDeadlineIndex();
    await index.hydrate(async (family) =>
      family === 'auditlogs' ? coldClock(f.tx, family, now, policy) : { past: false, next: null },
    );
    expect(index.obligations()).toEqual([]);
    const reads = f.queries.length;
    index.invalidate();
    expect(index.obligations()).toEqual([]);
    expect(f.queries).toHaveLength(reads);
  });
  it('keeps the ordinary valid clock at two indexed reads', async () => {
    const f = fixture([valid]);
    expect((await coldClock(f.tx, 'auditlogs', now, policy)).next).toBe(
      Date.parse(valid) + policy.audit_days * 86_400_000,
    );
    expect(f.queries).toHaveLength(2);
  });
});

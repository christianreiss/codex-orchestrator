import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';

export interface SqlAttempt {
  method: 'query' | 'execute' | 'beginTransaction' | 'commit' | 'rollback';
  kind: string;
  /** Stable SQL-shape attribution without parameter or literal disclosure. */
  fingerprint: string;
  tables: string[];
}

/** Test instrumentation at the driver boundary; never observes a query logger. */
export function installSqlBudget(pool: Pool) {
  const nesting = new AsyncLocalStorage<boolean>();
  let attempts: SqlAttempt[] = [];
  const originals = new Map<object, Map<string, unknown>>();
  function replace(target: object, name: string, replacement: unknown): void {
    const record = target as Record<string, unknown>;
    let methods = originals.get(target);
    if (!methods) {
      methods = new Map();
      originals.set(target, methods);
    }
    methods.set(name, record[name]);
    record[name] = replacement;
  }
  function track(target: Pool | PoolConnection): void {
    if (originals.has(target)) return;
    for (const method of ['query', 'execute', 'beginTransaction', 'commit', 'rollback'] as const) {
      const original = (target as unknown as Record<string, unknown>)[method];
      if (typeof original !== 'function') continue;
      replace(target, method, function (this: unknown, ...args: unknown[]) {
        if (nesting.getStore()) return original.apply(this, args);
        const input = args[0];
        const sql =
          typeof input === 'string'
            ? input
            : input && typeof input === 'object' && 'sql' in input && typeof input.sql === 'string'
              ? input.sql
              : '';
        const shape = sql
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/'(?:''|\\.|[^'])*'/g, '?')
          .replace(/\b\d+(?:\.\d+)?\b/g, '?')
          .replace(/\s+/g, ' ')
          .trim();
        const kind =
          method === 'beginTransaction'
            ? 'BEGIN'
            : method === 'commit'
              ? 'COMMIT'
              : method === 'rollback'
                ? 'ROLLBACK'
                : (/^([a-z]+)/i.exec(shape)?.[1]?.toUpperCase() ?? 'UNKNOWN');
        const tables = [
          ...new Set(
            [...shape.matchAll(/\b(?:from|join|update|into)\s+`?([a-z_][a-z0-9_]*)`?/gi)].map((match) =>
              match[1]!.toLowerCase(),
            ),
          ),
        ].sort();
        attempts.push({
          method,
          kind,
          tables,
          fingerprint: createHash('sha256')
            .update(shape || kind)
            .digest('hex')
            .slice(0, 16),
        });
        return nesting.run(true, () => original.apply(this, args));
      });
    }
  }
  track(pool);
  const acquire = pool.getConnection;
  replace(pool, 'getConnection', async function (this: Pool) {
    const connection = await acquire.call(this);
    track(connection);
    return connection;
  });
  return {
    track,
    reset() {
      attempts = [];
    },
    snapshot(): readonly SqlAttempt[] {
      return attempts.map((attempt) => ({ ...attempt, tables: [...attempt.tables] }));
    },
    restore() {
      for (const [target, methods] of originals) {
        for (const [name, original] of methods) (target as Record<string, unknown>)[name] = original;
      }
      originals.clear();
    },
  };
}

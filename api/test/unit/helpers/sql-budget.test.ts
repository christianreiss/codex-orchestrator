import { describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { installSqlBudget } from '../../helpers/sql-budget.js';

describe('SQL budget driver instrumentation', () => {
  it('counts pooled, held-connection and transaction statements without double counting', async () => {
    const connection = {
      async query(_sql: string) {
        return [[]];
      },
      async execute(_sql: string) {
        return [[]];
      },
      async beginTransaction() {
        await this.query('START TRANSACTION');
      },
      async commit() {
        await this.query('COMMIT');
      },
      async rollback() {
        await this.query('ROLLBACK');
      },
    };
    const pool = {
      async getConnection() {
        return connection;
      },
      async query(sql: string) {
        return (await this.getConnection()).query(sql);
      },
      async execute(sql: string) {
        return (await this.getConnection()).execute(sql);
      },
    };
    const original = pool.query;
    const budget = installSqlBudget(pool as unknown as Pool);
    await pool.query('SELECT 1');
    const held = await pool.getConnection();
    await held.beginTransaction();
    await held.execute('UPDATE rows SET value = ?');
    await held.commit();
    await held.rollback();
    expect(budget.snapshot().map((row) => row.kind)).toEqual([
      'SELECT',
      'BEGIN',
      'UPDATE',
      'COMMIT',
      'ROLLBACK',
    ]);
    expect(JSON.stringify(budget.snapshot())).not.toContain('value');
    expect(budget.snapshot()[2]?.tables).toEqual(['rows']);
    budget.reset();
    expect(budget.snapshot()).toEqual([]);
    budget.restore();
    expect(pool.query).toBe(original);
  });

  it('counts concurrent top-level queries independently and fingerprints without literals', async () => {
    const pool = {
      async query(_sql: string) {
        await Promise.resolve();
      },
      async getConnection() {
        throw new Error('unused');
      },
    };
    const budget = installSqlBudget(pool as unknown as Pool);
    await Promise.all([pool.query("SELECT 'first secret'"), pool.query("SELECT 'second secret'")]);
    expect(budget.snapshot()).toHaveLength(2);
    expect(budget.snapshot()[0]!.fingerprint).toBe(budget.snapshot()[1]!.fingerprint);
    expect(JSON.stringify(budget.snapshot())).not.toContain('secret');
    budget.restore();
  });
});

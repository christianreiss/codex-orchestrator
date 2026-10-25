import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { versions } from '../../../src/db/schema.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';

const config = readDbConfig();

// Deliberately CORE-only. This proves real persistence, ownership and hydrated
// reads; it does not start HTTP routes, communicators or production workers.
// Full-server/fleet zero-SQL acceptance remains a separate deployment gate.
describe.skipIf(!config)('owner core SQL budget against real MySQL', () => {
  it(
    'hydrates once, stays quiet with future obligations, commits and replays after restart',
    { timeout: 90_000 },
    async () => {
      const pool = mysql.createPool({ ...config!, connectionLimit: 3 });
      const budget = installSqlBudget(pool);
      const name = `test.owner-budget.${randomUUID()}`;
      const principal = `test:${randomUUID()}`;
      const id = randomUUID();
      const errors: unknown[] = [];
      const env = { ...loadTestEnv(), DB_DATABASE: String(config!.database) };
      let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
      const start = () =>
        createOwnedControlPlane({
          pool,
          handle: {},
          env,
          keyring: testKeyring(),
          error: (error) => errors.push(error),
        });
      try {
        owner = await start();
        expect(budget.snapshot().length).toBeGreaterThan(0);
        const prepare = vi.fn(
          ({ draft, write }: Parameters<Parameters<typeof mutateOwnerState>[1]['prepare']>[0]) => {
            const row = { name, version: 'persisted', updatedAt: new Date().toISOString() };
            draft.upsert('versions', row);
            write(async (tx) => {
              await tx.insert(versions).values(row);
            });
            return { accepted: true };
          },
        );
        const mutation = { id, principal, kind: 'test.owner-budget', payload: { name }, prepare };
        budget.reset();
        expect(await mutateOwnerState(owner.runtime, mutation)).toEqual({ accepted: true });
        expect(owner.runtime.state.snapshot().setting(name)).toBe('persisted');
        expect(budget.snapshot().some((row) => row.kind === 'BEGIN')).toBe(true);
        expect(budget.snapshot().some((row) => row.kind === 'COMMIT')).toBe(true);
        expect(prepare).toHaveBeenCalledTimes(1);

        // A scheduled provider check in the future is still a quiet fleet now.
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const due = vi.fn();
        owner.deadlines.schedule('provider:future', Date.now() + 20 * 60_000, due);
        budget.reset();
        for (let tick = 0; tick < 40; tick++) {
          for (let client = 0; client < 200; client++) {
            owner.runtime.assertOwner();
            expect(owner.runtime.state.snapshot().setting(name)).toBe('persisted');
          }
          await vi.advanceTimersByTimeAsync(15_000);
        }
        expect(budget.snapshot()).toEqual([]);
        expect(due).not.toHaveBeenCalled();
        owner.deadlines.cancel('provider:future');
        vi.useRealTimers();

        await owner.close();
        owner = await start();
        expect(owner.runtime.state.snapshot().setting(name)).toBe('persisted');
        budget.reset();
        expect(await mutateOwnerState(owner.runtime, mutation)).toEqual({ accepted: true });
        expect(prepare).toHaveBeenCalledTimes(2);
        const replay = budget.snapshot();
        expect(replay.some((row) => row.kind === 'ROLLBACK')).toBe(true);
        expect(
          replay.some(
            (row) => row.kind === 'SELECT' && row.tables.includes('control_plane_command_receipts'),
          ),
        ).toBe(true);
        expect(
          replay.some(
            (row) => ['INSERT', 'UPDATE', 'DELETE'].includes(row.kind) && row.tables.includes('versions'),
          ),
        ).toBe(false);
        expect(errors).toEqual([]);
      } finally {
        vi.useRealTimers();
        await owner?.close();
        // Remove only this test's unique durable fixture and command receipt.
        const connection = await pool.getConnection();
        try {
          await connection.execute('DELETE FROM versions WHERE name = ?', [name]);
          await connection.execute('DELETE FROM control_plane_command_receipts WHERE principal = ?', [
            principal,
          ]);
        } finally {
          connection.release();
        }
        budget.restore();
        await pool.end();
      }
    },
  );
});

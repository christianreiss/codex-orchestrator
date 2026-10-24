import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { RETENTION_FAMILIES, readRetentionClock } from '../../../src/services/server-retention/deadlines.js';
import { runOwnerHistoryRetention } from '../../../src/services/server-retention/owner.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';

const config = readDbConfig();
describe.skipIf(!config)('owner retention due transactions on real MySQL', () => {
  it(
    'hydrates every actual clock, removes due room history, and retains future rows',
    { timeout: 90_000 },
    async () => {
      const pool = mysql.createPool({ ...config!, connectionLimit: 3 });
      const budget = installSqlBudget(pool);
      const db = drizzle(pool, { schema, mode: 'default' });
      const pastId = randomUUID(),
        futureId = randomUUID(),
        room = randomUUID();
      const env = { ...loadTestEnv(), DB_DATABASE: String(config!.database) };
      const errors: unknown[] = [];
      let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
      try {
        // Different rooms: a newer event intentionally protects its whole room's history.
        for (const [id, roomId, created] of [
          [pastId, room, Date.now() - 172_800_000],
          [futureId, randomUUID(), Date.now()],
        ] as const) {
          await db
            .insert(schema.agentRoomEvents)
            .values({
              id,
              roomId,
              actor: 'test:retention',
              requestId: randomUUID(),
              payloadHash: '0'.repeat(64),
              bodyEnc: 'test:opaque-body-never-read',
              createdAt: new Date(created).toISOString(),
            });
        }
        owner = await createOwnedControlPlane({
          pool,
          handle: db,
          env,
          keyring: testKeyring(),
          error: (error) => errors.push(error),
        });
        expect(owner.retention.obligations().some((row) => row.key === 'history:rooms')).toBe(true);
        const tx = drizzle(owner.ownership.heldConnection(), { schema, mode: 'default' });
        for (const family of RETENTION_FAMILIES)
          await expect(readRetentionClock(tx, family, Date.now())).resolves.toHaveProperty('past');
        budget.reset();
        const changed = await runOwnerHistoryRetention(db, owner.runtime, 'rooms', env);
        expect(changed).toBeGreaterThanOrEqual(1);
        const [remaining] = await pool.execute('SELECT id FROM agent_room_events WHERE id IN (?, ?)', [
          pastId,
          futureId,
        ]);
        expect(remaining).toEqual([{ id: futureId }]);
        expect(budget.snapshot().some((row) => row.kind === 'COMMIT')).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        const epoch = owner?.runtime.state.revision().epoch;
        await owner?.close();
        if (epoch)
          await pool.execute('DELETE FROM control_plane_command_receipts WHERE owner_epoch = ?', [epoch]);
        await pool.execute('DELETE FROM agent_room_events WHERE id IN (?, ?)', [pastId, futureId]);
        budget.restore();
        await pool.end();
      }
    },
  );
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { acquireStorageOwnership } from '../../../src/control-plane/storage-owner.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { drainOwnedProviders } from '../../../src/control-plane/streams/provider-leases.js';
import * as schema from '../../../src/db/schema.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const config = readDbConfig();
describe.skipIf(!config)('internal provider tasks after owner restart', () => {
  it(
    'releases stopped API tasks across all engines, preserves remote/timed grants and unblocks removal',
    { timeout: 90_000 },
    async () => {
      const pool = mysql.createPool({ ...config!, connectionLimit: 3 });
      const db = drizzle(pool, { schema, mode: 'default' });
      const directory = await mkdtemp(join(tmpdir(), 'provider-owner-'));
      const env = { ...loadTestEnv(), DB_DATABASE: String(config!.database) };
      const keyring = testKeyring();
      const errors: unknown[] = [];
      let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
      let storage: Awaited<ReturnType<typeof acquireStorageOwnership>> | undefined;
      const accounts: Array<typeof schema.providerAccounts.$inferSelect> = [];
      const leases: Array<typeof schema.providerAccountSessions.$inferSelect> = [];
      const principal = 'test:internal-recovery:' + randomUUID();
      const start = () =>
        createOwnedControlPlane({ pool, handle: {}, env, keyring, error: (error) => errors.push(error) });
      try {
        storage = await acquireStorageOwnership(directory);
        owner = await start();
        await mutateOwnerState(owner.runtime, {
          principal,
          kind: 'test.internal-provider-tasks',
          payload: {},
          prepare({ draft, write }) {
            const now = new Date().toISOString();
            for (const engine of ['codex', 'claude', 'grok']) {
              for (const internal of [true, false]) {
                write(async (tx) => {
                  const values = {
                    engine,
                    label: 'test internal recovery',
                    identityKey: randomUUID(),
                    state: internal ? 'removing' : 'enabled',
                    createdAt: now,
                    updatedAt: now,
                  };
                  const [insert] = await tx.insert(schema.providerAccounts).values(values);
                  const account = {
                    ...values,
                    id: insert.insertId,
                    mergedIntoAccountId: null,
                    payloadId: null,
                    generation: null,
                    lastSelectedAt: null,
                  };
                  accounts.push(account);
                  draft.upsert('providerAccounts', account);
                  const kinds = internal
                    ? [{ hostId: 0, ownershipMode: 'connection' as const }]
                    : [
                        { hostId: 424242, ownershipMode: 'connection' as const },
                        { hostId: 424242, ownershipMode: 'timed' as const },
                        { hostId: 0, ownershipMode: 'timed' as const },
                      ];
                  for (const kind of kinds) {
                    const lease = {
                      ...kind,
                      id: randomUUID(),
                      engine,
                      scopeId: randomUUID(),
                      accountId: account.id,
                      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                      createdAt: now,
                    };
                    leases.push(lease);
                    await tx.insert(schema.providerAccountSessions).values(lease);
                    draft.upsert('providerAccountSessions', lease);
                  }
                });
              }
            }
            return null;
          },
        });
        expect(leases).toHaveLength(12);
        owner.ownership.lose(new Error('fixture lost database ownership'));
        await expect(acquireStorageOwnership(directory)).rejects.toThrow('still owns');
        expect(
          await db
            .select()
            .from(schema.providerAccountSessions)
            .where(
              inArray(
                schema.providerAccountSessions.id,
                leases.map((row) => row.id),
              ),
            ),
        ).toHaveLength(12);
        await owner.close();
        owner = undefined;
        await storage.close();
        storage = undefined;

        storage = await acquireStorageOwnership(directory);
        owner = await start();
        expect(owner.reconciledProviderTasks).toBe(3);
        for (const lease of leases) {
          const current = owner.runtime.state.snapshot().table('providerAccountSessions').get(lease.id);
          if (lease.hostId === 0 && lease.ownershipMode === 'connection') expect(current).toBeUndefined();
          else expect(current).toEqual(lease);
        }
        expect(
          await db
            .select()
            .from(schema.providerAccountSessions)
            .where(
              inArray(
                schema.providerAccountSessions.id,
                leases.map((row) => row.id),
              ),
            ),
        ).toHaveLength(9);
        await drainOwnedProviders(owner.runtime);
        for (const account of accounts) {
          expect(owner.runtime.state.snapshot().accounts.get(account.id)?.state).toBe(
            account.state === 'removing' ? 'removed' : 'enabled',
          );
        }
        await owner.close();
        owner = undefined;
        await storage.close();
        storage = undefined;
        storage = await acquireStorageOwnership(directory);
        owner = await start();
        expect(owner.reconciledProviderTasks).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await owner?.close();
        await storage?.close();
        if (leases.length)
          await db.delete(schema.providerAccountSessions).where(
            inArray(
              schema.providerAccountSessions.id,
              leases.map((row) => row.id),
            ),
          );
        if (accounts.length)
          await db.delete(schema.providerAccounts).where(
            inArray(
              schema.providerAccounts.id,
              accounts.map((row) => row.id),
            ),
          );
        await pool.execute('DELETE FROM control_plane_command_receipts WHERE principal = ?', [principal]);
        await pool.end();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

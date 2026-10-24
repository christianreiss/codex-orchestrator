import { randomUUID } from 'node:crypto';
import { afterAll, describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../../../src/db/schema.js';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { runMigrations } from '../../../src/db/migrator.js';
import { ControlPlaneOwnership } from '../../../src/control-plane/owner.js';
import { OwnerPersistence } from '../../../src/control-plane/persistence.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { hydrateOwnerState } from '../../../src/control-plane/state/hydrate.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { createCanonicalAuthStoreService } from '../../../src/services/canonical-auth-store.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';

const handle = await getTestDb();
describe.skipIf(!handle)('owned canonical auth on MySQL', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('commits encrypted bodies, metadata and account pointer together and serves a cold body from the RAM pointer', async () => {
    await runMigrations(handle!.pool, { appliedBy: 'owner-canonical-test' });
    const db = handle!.db,
      keyring = testKeyring(),
      now = new Date().toISOString(),
      action = 'owner.canonical.' + randomUUID();
    const [created] = await db.insert(schema.providerAccounts).values({
      engine: 'claude',
      label: action,
      state: 'enabled',
      generation: 0,
      createdAt: now,
      updatedAt: now,
    });
    const accountId = Number(created.insertId);
    const [priorHead] = await db
      .select()
      .from(schema.authCanonicalHeads)
      .where(eq(schema.authCanonicalHeads.engine, 'claude'));
    const owner = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test'),
      deadlines = new DeadlineQueue((error) => {
        throw error;
      }),
      commands: string[] = [];
    let close: (() => Promise<void>) | undefined;
    try {
      await owner.acquire();
      const { store } = await owner.hydrate((connection, epoch) =>
        hydrateOwnerState(drizzle(connection, { schema, mode: 'default' }), { epoch, sequence: 0n }),
      );
      owner.ready();
      const executor = new CommandExecutor({
        state: store,
        persistence: new OwnerPersistence(owner, keyring),
        assertOwner: () => owner.assertReady(),
        loseOwner: (error) => owner.lose(error),
        notificationError(error) {
          throw error;
        },
        committed(receipt) {
          commands.push(receipt.id);
        },
      });
      close = () => executor.drain();
      const runtime: OwnerRuntime = {
        state: store,
        deadlines,
        assertOwner: () => owner.assertReady(),
        execute: (command) => executor.execute(command),
      };
      bindOwnerRuntime(db, runtime);
      const validation = createRunnerValidationService({ db, keyring });
      const runner = {
        isConfigured: () => true,
        verify: async () => ({ ok: true, status: 'ok' as const, reachable: true }),
        verifyClaude: async () => ({ ok: true, status: 'ok' as const, reachable: true }),
      };
      const service = createCanonicalAuthStoreService({ db, keyring, runnerValidation: validation, runner });
      const result = await service.storeCandidate({
        accountId,
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: action,
        auth: {
          last_refresh: now,
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-owner-' + randomUUID(),
            refreshToken: randomUUID(),
            expiresAt: Date.now() + 86400000,
            refreshTokenExpiresAt: Date.now() + 86400000 * 30,
          },
        },
      });
      expect(result.verification_state).toBe('verified');
      const metadata = store.snapshot().table('authPayloads').get(result.pending_payload_id)!;
      expect(metadata).not.toHaveProperty('body');
      expect(store.snapshot().accounts.get(accountId)?.payloadId).toBe(metadata.id);
      const [persisted] = await db
        .select()
        .from(schema.providerAccounts)
        .where(eq(schema.providerAccounts.id, accountId));
      expect(persisted?.payloadId).toBe(metadata.id);
      const cold = await validation.resolveCanonicalPayload('claude', accountId);
      expect(cold?.id).toBe(metadata.id);
      expect(cold?.body).toMatch(/^sbox:/);
    } finally {
      await close?.();
      deadlines.close();
      await owner.close();
      if (commands.length)
        await db
          .delete(schema.controlPlaneCommandReceipts)
          .where(inArray(schema.controlPlaneCommandReceipts.requestId, commands));
      if (priorHead)
        await db.insert(schema.authCanonicalHeads).values(priorHead).onDuplicateKeyUpdate({ set: priorHead });
      else await db.delete(schema.authCanonicalHeads).where(eq(schema.authCanonicalHeads.engine, 'claude'));
      const payloads = await db
        .select({ id: schema.authPayloads.id })
        .from(schema.authPayloads)
        .where(eq(schema.authPayloads.accountId, accountId));
      await db
        .update(schema.providerAccounts)
        .set({ payloadId: null })
        .where(eq(schema.providerAccounts.id, accountId));
      if (payloads.length) {
        await db.delete(schema.authEntries).where(
          inArray(
            schema.authEntries.payloadId,
            payloads.map((p) => p.id),
          ),
        );
        await db.delete(schema.authPayloads).where(
          inArray(
            schema.authPayloads.id,
            payloads.map((p) => p.id),
          ),
        );
      }
      await db.delete(schema.providerAccounts).where(eq(schema.providerAccounts.id, accountId));
      await db.delete(schema.logs).where(eq(schema.logs.action, action));
    }
  });
});

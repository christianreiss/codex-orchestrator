import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { loadBaseline } from '../../../src/db/migrator.js';
import { ControlPlaneOwnership } from '../../../src/control-plane/owner.js';
import { OwnerPersistence } from '../../../src/control-plane/persistence.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { hydrateOwnerState } from '../../../src/control-plane/state/hydrate.js';
import {
  bindOwnerRuntime,
  mutateOwnerState,
  withOwnerActionIdentity,
  type OwnerRuntime,
} from '../../../src/control-plane/state/runtime.js';
import { stageDelete, stageUpdate } from '../../../src/control-plane/state/rows.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { persistAuditLog } from '../../../src/services/audit-log.js';
import { setOwnedGrokState } from '../../../src/control-plane/streams/canonical-state.js';
import { decrypt, encrypt } from '../../../src/security/secret-box.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const config = readDbConfig();
describe.skipIf(!config)('Grok owned response capture on real MySQL', () => {
  it('captures the exact spend once across head advancement and rolls back failed audit/persistence', async () => {
    const admin = mysql.createPool({ ...config!, connectionLimit: 1 });
    const database = 'grok_capture_' + randomUUID().replaceAll('-', '');
    let pool: mysql.Pool | undefined, ownership: ControlPlaneOwnership | undefined;
    let commands: { drain(): Promise<void> } | undefined, deadlines: DeadlineQueue | undefined;
    let presence: ConnectionPresence | undefined;
    try {
      await admin.query(`CREATE DATABASE \`${database}\``);
      pool = mysql.createPool({ ...config!, database, connectionLimit: 4 });
      const connection = await pool.getConnection();
      try {
        for (const statement of await loadBaseline()) await connection.query(statement);
      } finally {
        connection.release();
      }
      const db = drizzle(pool, { schema, mode: 'default' }),
        keyring = testKeyring();
      const now = new Date().toISOString();
      const ids: number[] = [];
      for (let index = 0; index < 4; index++) {
        const [row] = await db
          .insert(schema.providerAccounts)
          .values({
            engine: 'grok',
            label: 'capture-fixture',
            state: 'enabled',
            payloadId: 100 + index,
            generation: 8,
            createdAt: now,
            updatedAt: now,
          });
        ids.push(row.insertId);
      }
      ownership = new ControlPlaneOwnership(pool, database);
      const owner = ownership;
      await owner.acquire();
      const hydrated = await owner.hydrate((held, epoch) =>
        hydrateOwnerState(drizzle(held, { schema, mode: 'default' }), { epoch, sequence: 0n }, { keyring }),
      );
      owner.ready();
      deadlines = new DeadlineQueue((error) => {
        throw error;
      });
      const persistence = new OwnerPersistence(owner, keyring);
      const transactions = vi.spyOn(persistence, 'transaction');
      const executor = new CommandExecutor({
        state: hydrated.store,
        persistence,
        assertOwner: () => owner.assertReady(),
        loseOwner: (error) => owner.lose(error),
        committed() {},
        notificationError(error) {
          throw error;
        },
      });
      commands = executor;
      const runtime: OwnerRuntime = {
        state: hydrated.store,
        deadlines,
        assertOwner: () => owner.assertReady(),
        execute: (command) => executor.execute(command),
      };
      bindOwnerRuntime(db, runtime);
      presence = new ConnectionPresence((error) => {
        throw error;
      });
      bindOwnerPresence(runtime, presence);
      const published = vi.fn(),
        unsubscribe = runtime.state.subscribe(published);
      const [first, auditAccount, persistenceAccount, clearedAccount] = ids as [
        number,
        number,
        number,
        number,
      ];
      const proof = (accountId: number) => ({
        attemptId: `attempt-${accountId}`,
        basePayloadId: 100 + ids.indexOf(accountId),
        baseGeneration: 8,
      });
      const intent = (accountId: number) =>
        setOwnedGrokState(db, accountId, {
          state: 'refreshing',
          ...proof(accountId),
          responseEnc: null,
          startedAt: now,
          updatedAt: now,
        });
      const cipher = encrypt(JSON.stringify({ body: 'fixture-successful-provider-response' }), keyring);
      const capture = (accountId: number, responseEnc = cipher, attemptId = proof(accountId).attemptId) =>
        setOwnedGrokState(db, accountId, {
          state: 'refreshing',
          ...proof(accountId),
          attemptId,
          responseEnc,
          updatedAt: new Date().toISOString(),
        });
      const ledger = async (accountId: number) =>
        (
          await db
            .select()
            .from(schema.grokAuthRefreshState)
            .where(eq(schema.grokAuthRefreshState.accountId, accountId))
        )[0];
      for (const id of ids) await intent(id);
      await mutateOwnerState(runtime, {
        kind: 'fixture.advance-head',
        payload: {},
        prepare(ctx) {
          stageUpdate(ctx, 'providerAccounts', first, { payloadId: 999, generation: 9 });
          return null;
        },
      });
      await capture(first);
      expect(decrypt((await ledger(first))!.responseEnc!, keyring)).toContain(
        'fixture-successful-provider-response',
      );
      expect(runtime.state.snapshot().accounts.get(first)).toMatchObject({ payloadId: 999, generation: 9 });
      expect(runtime.state.snapshot().table('grokAuthRefreshState').get(first)).toMatchObject(proof(first));
      expect(runtime.state.snapshot().table('grokAuthRefreshState').get(first)).not.toHaveProperty(
        'responseEnc',
      );
      let before = runtime.state.snapshot();
      published.mockClear();
      // The CAS reaches MySQL but affects zero rows. Its receipt and RAM draft
      // must roll back rather than advertise a second capture.
      await expect(capture(first, encrypt('fixture-overwrite', keyring))).rejects.toMatchObject({
        code: 'grok_generation_conflict',
      });
      expect((await ledger(first))!.responseEnc).toBe(cipher);
      expect(runtime.state.snapshot()).toBe(before);
      expect(published).not.toHaveBeenCalled();
      transactions.mockClear();
      await expect(capture(first, cipher, 'foreign-attempt')).rejects.toMatchObject({
        code: 'grok_generation_conflict',
      });
      expect(transactions).not.toHaveBeenCalled();
      expect((await ledger(first))!.responseEnc).toBe(cipher);
      expect(runtime.state.snapshot()).toBe(before);

      const principal = 'test:grok-capture:' + randomUUID(),
        requestId = randomUUID();
      const auditedCapture = () =>
        withOwnerActionIdentity(
          {
            id: requestId,
            principal: { principal, revalidate() {} },
            revalidateTarget() {},
            afterPrepare(ctx) {
              ctx.write((tx) => persistAuditLog(tx, { action: 'fixture.grok.capture', createdAt: now }));
            },
          },
          () => capture(auditAccount),
        );
      await pool.query(
        "CREATE TRIGGER capture_audit_failure BEFORE INSERT ON logs FOR EACH ROW BEGIN IF NEW.action='fixture.grok.capture' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture capture audit failure'; END IF; END",
      );
      before = runtime.state.snapshot();
      published.mockClear();
      await expect(auditedCapture()).rejects.toMatchObject({
        cause: { sqlMessage: 'fixture capture audit failure' },
      });
      expect((await ledger(auditAccount))!.responseEnc).toBeNull();
      expect(await persistence.receipt(principal, requestId)).toBeUndefined();
      expect(runtime.state.snapshot()).toBe(before);
      expect(published).not.toHaveBeenCalled();
      await pool.query('DROP TRIGGER capture_audit_failure');
      await auditedCapture();
      expect((await ledger(auditAccount))!.responseEnc).toBe(cipher);
      expect(await persistence.receipt(principal, requestId)).toBeDefined();

      await pool.query(
        "CREATE TRIGGER capture_receipt_failure BEFORE UPDATE ON control_plane_command_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture capture persistence failure'",
      );
      before = runtime.state.snapshot();
      published.mockClear();
      await expect(capture(persistenceAccount)).rejects.toMatchObject({
        sqlMessage: 'fixture capture persistence failure',
      });
      expect((await ledger(persistenceAccount))!.responseEnc).toBeNull();
      expect(runtime.state.snapshot()).toBe(before);
      expect(published).not.toHaveBeenCalled();
      await pool.query('DROP TRIGGER capture_receipt_failure');
      await capture(persistenceAccount);
      expect((await ledger(persistenceAccount))!.responseEnc).toBe(cipher);

      await mutateOwnerState(runtime, {
        kind: 'fixture.clear-ledger',
        payload: {},
        prepare(ctx) {
          stageDelete(ctx, 'grokAuthRefreshState', clearedAccount);
          return null;
        },
      });
      before = runtime.state.snapshot();
      published.mockClear();
      transactions.mockClear();
      await expect(capture(clearedAccount)).rejects.toMatchObject({ code: 'grok_generation_conflict' });
      expect(transactions).not.toHaveBeenCalled();
      expect(await ledger(clearedAccount)).toBeUndefined();
      expect(runtime.state.snapshot()).toBe(before);
      expect(published).not.toHaveBeenCalled();
      unsubscribe();
    } finally {
      await commands?.drain();
      presence?.close();
      deadlines?.close();
      await ownership?.close();
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
  }, 90_000);
});

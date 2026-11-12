import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../../../src/db/schema.js';
import { getTestDb } from '../../helpers/test-db.js';
import { buildAppWithDb } from '../../helpers/build-app.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { ControlPlaneOwnership } from '../../../src/control-plane/owner.js';
import { OwnerPersistence, type PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { hydrateOwnerState } from '../../../src/control-plane/state/hydrate.js';
import type { OwnerStateSnapshot, PreparedOwnerState } from '../../../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { sha256 } from '../../../src/security/hash.js';
import { storeRtkPolicy, rtkPolicy, rtkPolicyKey, rtkReportKey } from '../../../src/services/rtk.js';
import { SettingsService } from '../../../src/services/settings.js';
import { registerRtkRoutes } from '../../../src/routes/rtk.js';

const handle = await getTestDb();
describe.skipIf(!handle)(
  'RTK owned policies and authenticated metadata against MySQL',
  { timeout: 120_000 },
  () => {
    afterAll(async () => {
      await handle?.pool.end();
    });
    it('persists all three policies atomically, rejects report authentication and suspended engines, and rolls back audit failures', async () => {
      const raw = handle!.db,
        env = loadTestEnv(),
        keyring = testKeyring(),
        now = new Date().toISOString();
      const suffix = randomUUID(),
        apiKey = 'rtk-test-' + suffix;
      const [insert] = await raw.insert(schema.hosts).values({
        fqdn: `rtk-${suffix}.test`,
        apiKey,
        apiKeyHash: sha256(apiKey),
        status: 'active',
        secure: 1,
        reverseDnsMode: 0,
        engines: 'codex,claude,grok,kimi',
        createdAt: now,
        updatedAt: now,
      });
      const hostId = Number(insert.insertId);
      const settingsKeys = ['codex', 'claude', 'grok', 'kimi'].flatMap((engine) => [
        rtkPolicyKey(engine as 'codex', hostId),
        rtkPolicyKey(engine as 'codex'),
        rtkReportKey(engine as 'codex', hostId),
        `${engine}_engine_disabled`,
      ]);
      const prior = await raw
        .select()
        .from(schema.versions)
        .where(inArray(schema.versions.name, settingsKeys));
      const ownership = new ControlPlaneOwnership(handle!.pool, 'rtk_owned_' + suffix);
      const deadlines = new DeadlineQueue((error) => {
        throw error;
      });
      const receipts: string[] = [];
      const presence = new ConnectionPresence((error) => {
        throw error;
      });
      let executor:
        | CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>
        | undefined;
      let app: Awaited<ReturnType<typeof buildAppWithDb>> | undefined;
      const trigger = 'rtk_audit_' + suffix.replaceAll('-', '');
      try {
        await ownership.acquire();
        const { store } = await ownership.hydrate((connection, epoch) =>
          hydrateOwnerState(
            drizzle(connection, { schema, mode: 'default' }),
            { epoch, sequence: 0n },
            { keyring },
          ),
        );
        ownership.ready();
        executor = new CommandExecutor({
          state: store,
          persistence: new OwnerPersistence(ownership, keyring),
          assertOwner: () => ownership.assertReady(),
          loseOwner: (error) => ownership.lose(error),
          committed(receipt) {
            receipts.push(receipt.id);
          },
          notificationError(error) {
            throw error;
          },
        });
        const db = drizzle(handle!.pool, { schema, mode: 'default' });
        const runtime = {
          state: store,
          deadlines,
          assertOwner: () => ownership.assertReady(),
          execute: (command: Parameters<OwnerRuntime['execute']>[0]) => executor!.execute(command),
        };
        bindOwnerRuntime(db, runtime);
        bindOwnerPresence(runtime, presence);
        for (const engine of ['codex', 'claude', 'grok', 'kimi'] as const) {
          await storeRtkPolicy(db, engine, true);
          expect(await rtkPolicy(db, engine, hostId)).toMatchObject({
            enabled: true,
            source: 'fleet',
            adapter_mode: 'instructions',
          });
          await storeRtkPolicy(db, engine, false, hostId);
          expect(
            (
              await raw
                .select()
                .from(schema.versions)
                .where(eq(schema.versions.name, rtkPolicyKey(engine, hostId)))
            )[0]?.version,
          ).toBe('false');
          expect(store.snapshot().settings.get(rtkPolicyKey(engine, hostId))?.version).toBe('false');
          await storeRtkPolicy(db, engine, null, hostId);
          expect(await rtkPolicy(db, engine, hostId)).toMatchObject({
            enabled: true,
            source: 'fleet',
            override: null,
          });
        }
        await handle!.pool.query(
          `CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON logs FOR EACH ROW BEGIN IF NEW.action='admin.rtk' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected RTK audit failure'; END IF; END`,
        );
        await expect(storeRtkPolicy(db, 'codex', false)).rejects.toThrow();
        expect(
          (await raw.select().from(schema.versions).where(eq(schema.versions.name, 'rtk_codex')))[0]?.version,
        ).toBe('true');
        expect(store.snapshot().settings.get('rtk_codex')?.version).toBe('true');
        await handle!.pool.query(`DROP TRIGGER \`${trigger}\``);
        app = await buildAppWithDb(db, { env, keyring });
        await registerRtkRoutes(app, { db, env, keyring });
        const errors: string[] = [];
        app.addHook('onError', async (_req, _reply, error) => {
          errors.push(error.stack ?? error.message);
        });
        const report = {
          engine: 'grok',
          ready: true,
          adapter_mode: 'instructions',
          wrapper_version: '0.9.169',
          native_version: '1.0.77',
          rtk_version: '1.2.0',
          policy_revision: (await rtkPolicy(db, 'grok', hostId)).policy_revision,
        };
        expect(
          (await app.inject({ method: 'POST', url: '/host/rtk/report', payload: report })).statusCode,
        ).toBe(401);
        const headers = { 'X-API-Key': apiKey };
        const accepted = await app.inject({
          method: 'POST',
          url: '/host/rtk/report',
          headers,
          payload: report,
        });
        expect(accepted.statusCode, JSON.stringify(errors)).toBe(200);
        const persisted = (
          await raw
            .select()
            .from(schema.versions)
            .where(eq(schema.versions.name, rtkReportKey('grok', hostId)))
        )[0]!;
        expect(JSON.parse(persisted.version!)).toMatchObject({ ...report, observed_at: expect.any(String) });
        const rejected = await app.inject({
          method: 'POST',
          url: '/host/rtk/report',
          headers,
          payload: { ...report, command: 'never retain command content' },
        });
        expect(rejected.statusCode).toBe(422);
        await new SettingsService(db).set('grok_engine_disabled', '1');
        expect(
          (await app.inject({ method: 'POST', url: '/host/rtk/report', headers, payload: report }))
            .statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              method: 'GET',
              url: '/wrapper/v2/rtk/v1.2.0/linux-amd64?engine=grok',
              headers,
            })
          ).statusCode,
        ).toBe(403);
        const audit = await raw
          .select()
          .from(schema.logs)
          .where(and(eq(schema.logs.hostId, hostId), eq(schema.logs.action, 'admin.rtk')));
        expect(audit).toHaveLength(6);
      } finally {
        await app?.close();
        await executor?.drain();
        presence.close();
        deadlines.close();
        await ownership.close();
        await handle!.pool.query(`DROP TRIGGER IF EXISTS \`${trigger}\``);
        await raw.delete(schema.versions).where(inArray(schema.versions.name, settingsKeys));
        if (prior.length) await raw.insert(schema.versions).values(prior);
        if (receipts.length)
          await raw
            .delete(schema.controlPlaneCommandReceipts)
            .where(inArray(schema.controlPlaneCommandReceipts.requestId, receipts));
        await raw.delete(schema.adminEvents).where(eq(schema.adminEvents.hostId, hostId));
        await raw.delete(schema.logs).where(eq(schema.logs.hostId, hostId));
        await raw.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
      }
    });
  },
);

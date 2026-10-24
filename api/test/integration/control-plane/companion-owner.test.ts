import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { runBootMigrations } from '../../../src/ops/boot-migrations.js';
import { CompanionDevices } from '../../../src/services/companion/devices.js';
import { OwnerCompanionPush } from '../../../src/services/companion/push-owner.js';
import { FcmTransport } from '../../../src/services/companion/fcm.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';
import type { RouteContext } from '../../../src/routes/index.js';
const config = readDbConfig();
describe.skipIf(!config)('owner companion lifecycle on real MySQL', () => {
  it(
    'pairs once, reads active devices without SQL, stages push intents, preserves unknown delivery and revokes immediately',
    { timeout: 90_000 },
    async () => {
      const pool = mysql.createPool({ ...config!, connectionLimit: 4 });
      const db = drizzle(pool, { schema, mode: 'default' });
      const budget = installSqlBudget(pool);
      const env = {
        ...loadTestEnv(),
        PUBLIC_BASE_URL: 'https://fleet.example',
        COMPANION_FIREBASE_PROJECT_ID: 'test',
        COMPANION_FIREBASE_CREDENTIAL_FILE: '/never-read',
      };
      const keyring = testKeyring();
      const name = `owner-companion-${randomUUID()}`;
      let userId: number | undefined,
        hostId: number | undefined,
        requestId: number | undefined,
        deviceId: string | undefined;
      const effects: string[] = [];
      let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
      const errors: unknown[] = [];
      try {
        await runBootMigrations(env, pool);
        const now = new Date().toISOString();
        const [u] = await db
          .insert(schema.adminUsers)
          .values({
            name,
            username: name,
            email: `${name}@example.test`,
            passwordHash: 'test',
            accessLevel: 'owner',
            active: 1,
            createdAt: now,
            updatedAt: now,
          });
        userId = u.insertId;
        const [h] = await db
          .insert(schema.hosts)
          .values({
            fqdn: `${name}.example.test`,
            apiKey: randomUUID(),
            secure: 0,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          });
        hostId = h.insertId;
        const [r] = await db
          .insert(schema.insecureAuthRequests)
          .values({
            hostId,
            status: 'pending',
            requestedAt: new Date(Date.now() - 1000).toISOString(),
            updatedAt: now,
            engine: 'codex',
          });
        requestId = r.insertId;
        owner = await createOwnedControlPlane({
          pool,
          handle: db,
          env,
          keyring,
          error: (e) => errors.push(e),
        });
        const ctx = { db, env, keyring } as RouteContext;
        const devices = new CompanionDevices(ctx);
        const pairing = JSON.parse((await devices.pair(userId)).qr) as { token: string };
        const credential = await devices.exchange(pairing.token, 'Owner test');
        deviceId = credential.device_id;
        await expect(devices.exchange(pairing.token, 'Replay')).rejects.toThrow();
        await devices.patch(deviceId, { fcm_token: 'test-fcm-token' });
        budget.reset();
        for (let i = 0; i < 200; i++) {
          await devices.authenticate(`Bearer ${credential.token}`);
          await devices.list(userId);
          await devices.patch(deviceId, { visible_session_id: null });
        }
        expect(budget.snapshot()).toEqual([]);
        const transport = new FcmTransport(env);
        const send = vi.spyOn(transport, 'send').mockRejectedValue(new Error('Ambiguous network failure'));
        const push = new OwnerCompanionPush(ctx, transport);
        const approval = push
          .obligations(owner.runtime.state.snapshot())
          .find((w) => w.key === `approval:${deviceId}:${requestId}`);
        expect(approval).toBeDefined();
        await push.run(approval!);
        const sendWork = push
          .obligations(owner.runtime.state.snapshot())
          .find((w) => w.key.startsWith('send:'));
        expect(sendWork).toBeDefined();
        await push.run(sendWork!);
        const outbox = owner.runtime.state
          .snapshot()
          .table('controlPlaneOutbox')
          .all()
          .find((e) => e.kind === 'companion.push' && e.target === sendWork!.key.slice(5));
        expect(outbox).toBeDefined();
        effects.push(outbox!.id);
        expect(await push.effect({ id: outbox!.id, target: outbox!.target, payload: {} })).toEqual({
          status: 'uncertain',
        });
        expect(send).toHaveBeenCalledTimes(1);
        expect(
          owner.runtime.state.snapshot().table('companionNotifications').get(outbox!.target)?.state,
        ).toBe('uncertain');
        expect(push.obligations(owner.runtime.state.snapshot()).some((w) => w.key === sendWork!.key)).toBe(
          false,
        );
        await devices.revoke(userId, deviceId);
        budget.reset();
        await expect(devices.authenticate(`Bearer ${credential.token}`)).rejects.toThrow();
        expect(budget.snapshot()).toEqual([]);
        await mutateOwnerState(owner.runtime, {
          kind: 'fixture.resolve',
          payload: {},
          prepare: (c) => {
            stageUpdate(c, 'insecureAuthRequests', requestId!, { status: 'denied' });
            return null;
          },
        });
        expect(errors).toEqual([]);
      } finally {
        const epoch = owner?.runtime.state.revision().epoch;
        await owner?.close();
        if (epoch)
          await pool.execute('DELETE FROM control_plane_command_receipts WHERE owner_epoch = ?', [epoch]);
        if (effects.length)
          await db.delete(schema.controlPlaneOutbox).where(inArray(schema.controlPlaneOutbox.id, effects));
        if (deviceId) {
          await db
            .delete(schema.companionNotifications)
            .where(eq(schema.companionNotifications.deviceId, deviceId));
          await db.delete(schema.companionDevices).where(eq(schema.companionDevices.id, deviceId));
        }
        if (requestId)
          await db.delete(schema.insecureAuthRequests).where(eq(schema.insecureAuthRequests.id, requestId));
        if (hostId) await db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
        if (userId) {
          await db.delete(schema.companionPairings).where(eq(schema.companionPairings.userId, userId));
          await db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, userId));
        }
        budget.restore();
        await pool.end();
      }
    },
  );
});

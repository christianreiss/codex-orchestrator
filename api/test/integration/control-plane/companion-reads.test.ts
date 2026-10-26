import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { runBootMigrations } from '../../../src/ops/boot-migrations.js';
import { CompanionDevices } from '../../../src/services/companion/devices.js';
import { companionReadCursors } from '../../../src/services/companion/reads.js';
import { OwnerCompanionPush } from '../../../src/services/companion/push-owner.js';
import { FcmTransport } from '../../../src/services/companion/fcm.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';
import type { RouteContext } from '../../../src/routes/index.js';
const config = readDbConfig();
describe.skipIf(!config)('owned shared companion reads', () => {
  it('merges devices, stays idle on replay, gates silent pushes and survives owner restart', { timeout: 90000 }, async () => {
    const pool = mysql.createPool({ ...config!, connectionLimit: 4 });
    const db = drizzle(pool, { schema, mode: 'default' });
    const env = { ...loadTestEnv(), PUBLIC_BASE_URL: 'https://fleet.example', COMPANION_FIREBASE_PROJECT_ID: 'test', COMPANION_FIREBASE_CREDENTIAL_FILE: '/never-read' };
    const keyring = testKeyring(), now = new Date().toISOString(), name = `reads-${randomUUID()}`, sessionId = randomUUID();
    let userId: number | undefined, hostId: number | undefined;
    let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
    const devices: string[] = [], epochs: string[] = [];
    const errors: unknown[] = [];
    const [oldPortal] = await db.select().from(schema.versions).where(eq(schema.versions.name, 'agent_portal_enabled'));
    try {
      await runBootMigrations(env, pool);
      const [user] = await db.insert(schema.adminUsers).values({ name, username: name, email: `${name}@example.test`, passwordHash: 'test', accessLevel: 'owner', active: 1, createdAt: now, updatedAt: now }); userId = user.insertId;
      const [host] = await db.insert(schema.hosts).values({ fqdn: `${name}.example.test`, apiKey: randomUUID(), secure: 0, status: 'active', createdAt: now, updatedAt: now }); hostId = host.insertId;
      await db.insert(schema.versions).values({ name: 'agent_portal_enabled', version: '1', updatedAt: now }).onDuplicateKeyUpdate({ set: { version: '1' } });
      await db.insert(schema.agentSessions).values({ id: sessionId, hostId, engine: 'codex', username: 'test', cwd: '/test', invocationKind: 'native', status: 'running', hostAuthFingerprint: '0'.repeat(64), bridgeTokenHash: '0'.repeat(64), bridgeExpiresAt: now, startedAt: now, heartbeatAt: now, createdAt: now, updatedAt: now });
      const put = async () => { const [r] = await db.insert(schema.agentEvents).values({ sessionId, clientEventId: randomUUID(), eventType: 'assistant_message', source: 'bridge', payloadEnc: encrypt('{"text":"Read fixture"}', keyring), createdAt: now }); return r.insertId; };
      const first = await put(), second = await put();
      owner = await createOwnedControlPlane({ pool, handle: db, env, keyring, error: e => errors.push(e) }); epochs.push(owner.runtime.state.revision().epoch);
      const ctx = { db, env, keyring } as RouteContext, service = new CompanionDevices(ctx);
      const pair = async (name: string) => { const p = await service.pair(userId!); const d = await service.exchange(JSON.parse(p.qr).token, name); devices.push(d.device_id); return d; };
      const phone = await pair('Old phone'), tablet = await pair('New tablet');
      await service.patch(phone.device_id, { fcm_token: 'old-test-token' });
      await service.patch(tablet.device_id, { fcm_token: 'new-test-token', read_sync_protocol: 1 });
      const sessions = [{ id: sessionId }];
      expect(await companionReadCursors(ctx, userId, sessions, new Map(), { [sessionId]: first }, phone.device_id)).toEqual({ [sessionId]: first });
      const budget = installSqlBudget(pool);
      try {
        budget.reset();
        expect(await companionReadCursors(ctx, userId, sessions, new Map(), { [sessionId]: first }, tablet.device_id)).toEqual({ [sessionId]: first });
        expect(budget.snapshot()).toEqual([]);
      } finally { budget.restore(); }
      await Promise.all([
        companionReadCursors(ctx, userId, sessions, new Map(), { [sessionId]: second }, phone.device_id),
        companionReadCursors(ctx, userId, sessions, new Map(), { [sessionId]: first }, tablet.device_id),
      ]);
      expect(await companionReadCursors(ctx, userId, sessions, new Map())).toEqual({ [sessionId]: second });
      const jobs = owner.runtime.state.snapshot().table('companionNotifications').all().filter(j => j.kind === 'read');
      expect(jobs).toHaveLength(2);
      expect(jobs.every(j => j.deviceId === tablet.device_id)).toBe(true);
      await service.patch(tablet.device_id, { visible_session_id: sessionId });
      const transport = new FcmTransport(env), send = vi.spyOn(transport, 'send').mockResolvedValue('sent');
      const push = new OwnerCompanionPush(ctx, transport);
      const work = push.obligations(owner.runtime.state.snapshot()).find(w => w.key === `send:${jobs[0]!.id}`)!;
      expect(work).toBeDefined(); await push.run(work);
      expect(await push.effect({ id: randomUUID(), target: jobs[0]!.id, payload: {} })).toEqual({ status: 'delivered' });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![1]).toMatchObject({ kind: 'read', device_id: tablet.device_id, target_id: sessionId, event_cursor: String(second) });
      expect(send.mock.calls[0]![1]).not.toHaveProperty('summary');
      await owner.close(); owner = undefined;
      const freshDb = drizzle(pool, { schema, mode: 'default' });
      owner = await createOwnedControlPlane({ pool, handle: freshDb, env, keyring, error: e => errors.push(e) }); epochs.push(owner.runtime.state.revision().epoch);
      expect(await companionReadCursors({ ...ctx, db: freshDb } as RouteContext, userId, sessions, new Map())).toEqual({ [sessionId]: second });
      expect(errors).toEqual([]);
    } finally {
      await owner?.close();
      for (const epoch of epochs) await pool.execute('DELETE FROM control_plane_command_receipts WHERE owner_epoch = ?', [epoch]);
      const [outboxes] = await pool.query<mysql.RowDataPacket[]>('SELECT id FROM control_plane_outbox WHERE kind = ? AND target IN (SELECT id FROM companion_notifications WHERE device_id IN (?))', ['companion.push', devices.length ? devices : ['none']]);
      if (outboxes.length) await db.delete(schema.controlPlaneOutbox).where(inArray(schema.controlPlaneOutbox.id, outboxes.map(r => r.id)));
      if (devices.length) { await db.delete(schema.companionNotifications).where(inArray(schema.companionNotifications.deviceId, devices)); await db.delete(schema.companionDevices).where(inArray(schema.companionDevices.id, devices)); }
      await db.delete(schema.agentEvents).where(eq(schema.agentEvents.sessionId, sessionId));
      await db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId));
      if (hostId) await db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
      if (userId) await db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, userId));
      if (oldPortal) await db.update(schema.versions).set({ version: oldPortal.version }).where(eq(schema.versions.name, 'agent_portal_enabled'));
      else await db.delete(schema.versions).where(eq(schema.versions.name, 'agent_portal_enabled'));
      await pool.end();
    }
  });
});

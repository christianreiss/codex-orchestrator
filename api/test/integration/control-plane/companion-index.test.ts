import { currentCanonicalMetadata } from '../../../src/control-plane/state/canonical-metadata.js';
import { sha256 } from '../../../src/security/hash.js';
import { appendAuditLog, persistAuditLog } from '../../../src/services/audit-log.js';
import { DashboardStatsService } from '../../../src/services/dashboard-stats.js';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { describe, it, expect, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { stagePortalEvent } from '../../../src/control-plane/state/portal-events.js';
import { companionPreviews } from '../../../src/services/companion/summary.js';
import { encrypt } from '../../../src/security/secret-box.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
const config = readDbConfig();
describe.skipIf(!config)('owned companion summaries on MySQL', () => {
  it('hydrates retained ended aliases, stages new events, reads only requested bodies and falls back for old cursors', async () => {
    const pool = mysql.createPool({ ...config!, connectionLimit: 4 }),
      db = drizzle(pool, { schema, mode: 'default' }),
      now = new Date().toISOString(),
      ids = [randomUUID(), randomUUID()],
      logical = randomUUID(),
      epochs: string[] = [],
      errors: unknown[] = [],
      auditAction = 'test.audit.' + randomUUID();
    const env = { ...loadTestEnv(), DB_DATABASE: String(config!.database) },
      keyring = testKeyring();
    let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined,
      hostId = 0,
      payloadId = 0;
    try {
      const [host] = await db
        .insert(schema.hosts)
        .values({
          fqdn: 'companion-index-' + randomUUID() + '.test',
          apiKey: randomUUID(),
          secure: 1,
          status: 'active',
          engines: 'claude',
          createdAt: now,
          updatedAt: now,
        })
        .$returningId();
      hostId = host!.id;
      for (const id of ids)
        await db.insert(schema.agentSessions).values({
          id,
          hostId,
          engine: 'claude',
          username: 'root',
          cwd: '/test',
          invocationKind: 'native',
          status: 'ended',
          hostAuthFingerprint: '0'.repeat(64),
          bridgeTokenHash: '0'.repeat(64),
          bridgeExpiresAt: now,
          startedAt: now,
          heartbeatAt: now,
          endedAt: now,
          expiresAt: now,
          createdAt: now,
          updatedAt: now,
        });
      await db.insert(schema.agentEvents).values(
        Array.from({ length: 300 }, (_, n) => ({
          sessionId: ids[0]!,
          clientEventId: randomUUID(),
          eventType: 'assistant_message',
          source: 'bridge',
          payloadEnc: encrypt(JSON.stringify({ summary: 'Reply ' + n }), keyring),
          createdAt: now,
        })),
      );
      const firstEvents = await db
        .select({ id: schema.agentEvents.id })
        .from(schema.agentEvents)
        .where(eq(schema.agentEvents.sessionId, ids[0]!));
      await db.insert(schema.agentEvents).values({
        sessionId: ids[1]!,
        clientEventId: randomUUID(),
        eventType: 'assistant_message',
        source: 'bridge',
        payloadEnc: encrypt(JSON.stringify({ summary: 'Alias reply' }), keyring),
        createdAt: now,
      });
      const canonicalBody = JSON.stringify({
        last_refresh: now,
        auths: { 'api.anthropic.com': { token: 'sk-ant-api03-' + 'x'.repeat(64) } },
      });
      const [payload] = await db
        .insert(schema.authPayloads)
        .values({
          engine: 'claude',
          lastRefresh: now,
          sha256: sha256(canonicalBody),
          body: encrypt(canonicalBody, keyring),
          verificationState: 'verified',
          createdAt: now,
          sourceHostId: hostId,
        })
        .$returningId();
      payloadId = payload!.id;
      owner = await createOwnedControlPlane({ pool, handle: db, env, keyring, error: (e) => errors.push(e) });
      epochs.push(owner.runtime.state.revision().epoch);
      expect(
        owner.runtime.state.snapshot().table('authPayloads').get(payloadId)?.canonicalBodyProof,
      ).not.toBeNull();
      const canonical = currentCanonicalMetadata(owner.runtime.state.snapshot(), 'claude');
      expect(canonical?.id).toBe(payloadId);
      expect(canonical?.sha256).toBe(sha256(canonicalBody));
      const ctx = { db, keyring } as RouteContext,
        aliases = new Map(ids.map((id) => [id, logical]));
      const select = vi.spyOn(db, 'select');
      const initial = await companionPreviews(ctx, [{ id: logical }], {}, aliases);
      expect(initial[0]).toMatchObject({ unread_reply_count: 301, preview: { summary: 'Alias reply' } });
      expect(select).toHaveBeenCalledTimes(1); // Explicitly requested encrypted preview bodies only.
      select.mockClear();
      expect(
        (
          await companionPreviews(
            ctx,
            [{ id: logical }],
            { [logical]: Number(initial[0]!.reply_cursor) },
            aliases,
          )
        )[0]!.unread_reply_count,
      ).toBe(0);
      expect(select).toHaveBeenCalledTimes(1);
      select.mockClear();
      expect(
        (await companionPreviews(ctx, [{ id: logical }], { [logical]: firstEvents[0]!.id }, aliases))[0]!
          .unread_reply_count,
      ).toBe(300);
      expect(select).toHaveBeenCalledTimes(2);
      select.mockRestore();
      await mutateOwnerState(owner.runtime, {
        kind: 'test.companion.reply',
        payload: {},
        prepare: (c) => {
          stagePortalEvent(c, {
            sessionId: ids[1]!,
            clientEventId: randomUUID(),
            eventType: 'assistant_message',
            source: 'bridge',
            payloadEnc: encrypt(JSON.stringify({ summary: 'Committed reply' }), keyring),
            createdAt: now,
          });
          return null;
        },
      });
      expect((await companionPreviews(ctx, [{ id: logical }], {}, aliases))[0]).toMatchObject({
        unread_reply_count: 302,
        preview: { summary: 'Committed reply' },
      });
      const dashboard = new DashboardStatsService(db),
        auditAt = '2097-02-03T04:05:06Z';
      await appendAuditLog(db, { action: auditAction, createdAt: auditAt, details: 'private audit body' });
      const reads = vi.spyOn(db, 'select');
      expect(await dashboard.latestLogAt()).toBe(auditAt);
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
      await appendAuditLog(db, { action: auditAction, createdAt: '2000-01-01T00:00:00Z' });
      expect(await dashboard.latestLogAt()).toBe(auditAt);
      await expect(
        mutateOwnerState(owner.runtime, {
          kind: 'test.audit.rollback',
          payload: {},
          prepare(c) {
            c.write(async (tx) => {
              await persistAuditLog(tx, { action: auditAction, createdAt: '2098-01-01T00:00:00Z' });
              throw new Error('rollback audit');
            });
            return null;
          },
        }),
      ).rejects.toThrow('rollback audit');
      expect(await dashboard.latestLogAt()).toBe(auditAt);
      const expected = ids.map((id) => owner!.runtime.state.snapshot().sessions.get(id)!.companionEvents);
      await owner.close();
      owner = undefined;
      const freshDb = drizzle(pool, { schema, mode: 'default' });
      owner = await createOwnedControlPlane({
        pool,
        handle: freshDb,
        env,
        keyring,
        error: (e) => errors.push(e),
      });
      epochs.push(owner.runtime.state.revision().epoch);
      expect(ids.map((id) => owner!.runtime.state.snapshot().sessions.get(id)!.companionEvents)).toEqual(
        expected,
      );
      expect(currentCanonicalMetadata(owner.runtime.state.snapshot(), 'claude')?.id).toBe(payloadId);
      expect(await new DashboardStatsService(freshDb).latestLogAt()).toBe(auditAt);
      expect(errors).toEqual([]);
    } finally {
      await owner?.close();
      if (payloadId) await db.delete(schema.authPayloads).where(eq(schema.authPayloads.id, payloadId));
      await db.delete(schema.logs).where(eq(schema.logs.action, auditAction));
      await db.delete(schema.agentEvents).where(inArray(schema.agentEvents.sessionId, ids));
      await db.delete(schema.agentSessions).where(inArray(schema.agentSessions.id, ids));
      if (hostId) await db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
      if (epochs.length)
        await db
          .delete(schema.controlPlaneCommandReceipts)
          .where(inArray(schema.controlPlaneCommandReceipts.ownerEpoch, epochs));
      await pool.end();
    }
  }, 90000);
});

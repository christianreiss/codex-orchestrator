import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { runBootMigrations } from '../../../src/ops/boot-migrations.js';
import { OwnedChattyActions } from '../../../src/services/chatty/owner-actions.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import type { ChattyTool } from '../../../src/services/chatty/tools.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { ChattyStore } from '../../../src/services/chatty/store.js';
import { DEFAULT_SETTINGS } from '../../../src/services/chatty/contracts.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';
const config = readDbConfig();
describe.skipIf(!config)('Chatty owner store on real MySQL', () => {
  it(
    'owns claims without durable heartbeats and preserves uncertain work across replacement',
    { timeout: 90_000 },
    async () => {
      const pool = mysql.createPool({ ...config!, connectionLimit: 4 });
      const db = drizzle(pool, { schema, mode: 'default' }),
        env = loadTestEnv(),
        keyring = testKeyring(),
        budget = installSqlBudget(pool);
      const saved = await db
        .select()
        .from(schema.versions)
        .where(eq(schema.versions.name, 'chatty_settings'));
      const epochs: string[] = [];
      let hostId: number | undefined,
        userId: number | undefined,
        sessionId: number | undefined,
        owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
      const errors: unknown[] = [];
      try {
        await runBootMigrations(env, pool);
        const stamp = new Date().toISOString(),
          name = `chatty-owner-${randomUUID()}`;
        const [u] = await db
          .insert(schema.adminUsers)
          .values({
            name,
            username: name,
            email: `${name}@test.example`,
            passwordHash: 'test',
            accessLevel: 'owner',
            active: 1,
            createdAt: stamp,
            updatedAt: stamp,
          });
        userId = u.insertId;
        const [host] = await db
          .insert(schema.hosts)
          .values({
            fqdn: `${name}.example.test`,
            apiKey: randomUUID(),
            secure: 1,
            status: 'active',
            createdAt: stamp,
            updatedAt: stamp,
          });
        hostId = host.insertId;
        const [s] = await db
          .insert(schema.adminSessions)
          .values({
            userId,
            tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
            createdAt: stamp,
            lastSeenAt: stamp,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          });
        sessionId = s.insertId;
        await db
          .insert(schema.versions)
          .values({
            name: 'chatty_settings',
            version: JSON.stringify({ ...DEFAULT_SETTINGS, enabled: true }),
            updatedAt: stamp,
          })
          .onDuplicateKeyUpdate({
            set: { version: JSON.stringify({ ...DEFAULT_SETTINGS, enabled: true }), updatedAt: stamp },
          });
        owner = await createOwnedControlPlane({
          pool,
          handle: db,
          env,
          keyring,
          error: (e) => errors.push(e),
        });
        epochs.push(owner.runtime.state.revision().epoch);
        let store = new ChattyStore(db, keyring);
        const actor = { userId, sessionId };
        const session = await store.session(userId);
        const request = {
          client_message_id: randomUUID(),
          generation: session.generation,
          text: 'Explicit test run',
        };
        const submitted = await store.submit(actor, request);
        expect(await store.submit(actor, request)).toEqual(submitted);
        const run = await store.claim();
        expect(run?.id).toBe(submitted.id);
        expect(run?.leaseUntil).toBeNull();
        budget.reset();
        for (let i = 0; i < 200; i++) {
          await store.current(run!);
          await store.heartbeat(run!);
          await store.settings();
          await store.active(userId);
        }
        expect(budget.snapshot()).toEqual([]);
        let invoked = 0;
        const tool: ChattyTool = {
          name: 'host_vip',
          description: 'test mutation',
          capability: 'hosts.manage',
          write: true,
          confirm: false,
          parameters: {},
          parse: (v) => v as Record<string, unknown>,
          snapshot: async () => ({ vip: owner!.runtime.state.snapshot().table('hosts').get(hostId!)!.vip }),
          run: async () => {
            invoked++;
            await mutateOwnerState(owner!.runtime, {
              kind: 'test.host.vip',
              payload: { id: hostId! },
              prepare: (c) => {
                stageUpdate(c, 'hosts', hostId!, { vip: 1 });
                return { vip: true };
              },
            });
            throw new Error('Lost coordinator continuation after service commit');
          },
        };
        const actions = new OwnedChattyActions({
          store,
          tools: [tool],
          context: () => ({ ...({ db, env, keyring } as RouteContext), actor }),
        });
        const state = {
          messages: [],
          sources: [],
        } as import('../../../src/services/chatty/store.js').RunState;
        await actions.prepare(run!, tool, { id: hostId }, state, 0);
        const action = owner.runtime.state
          .snapshot()
          .table('chattyActions')
          .all()
          .find((a) => a.runId === run!.id)!;
        await actions.perform(run!, action.id, state);
        expect(invoked).toBe(1);
        expect(owner.runtime.state.snapshot().table('hosts').get(hostId)?.vip).toBe(1);
        expect(owner.runtime.state.snapshot().table('chattyActions').get(action.id)?.status).toBe(
          'succeeded',
        );
        expect(state.messages).toHaveLength(1);
        await actions.perform(run!, action.id, state);
        expect(invoked).toBe(1);
        const eventCursor = owner.runtime.state.snapshot().table('chattySessions').get(userId)?.eventCursor;
        expect(eventCursor).toBeGreaterThan(0);
        await owner.close();
        const replacementDb = drizzle(pool, { schema, mode: 'default' });
        owner = await createOwnedControlPlane({
          pool,
          handle: replacementDb,
          env,
          keyring,
          error: (e) => errors.push(e),
        });
        epochs.push(owner.runtime.state.revision().epoch);
        store = new ChattyStore(replacementDb, keyring);
        expect(owner.runtime.state.snapshot().table('chattySessions').get(userId)?.eventCursor).toBe(
          eventCursor,
        );
        expect(await store.claim()).toBeNull();
        expect(owner.runtime.state.snapshot().table('chattyRuns').get(submitted.id)?.status).toBe('unknown');
        await expect(store.current(run!)).rejects.toThrow();
        expect((await store.clear(userId)).generation).toBe(2);
        expect(errors).toEqual([]);
      } finally {
        await owner?.close();
        for (const epoch of epochs)
          await pool.execute('DELETE FROM control_plane_command_receipts WHERE owner_epoch = ?', [epoch]);
        if (userId) {
          await db.delete(schema.chattyActions).where(eq(schema.chattyActions.userId, userId));
          await db.delete(schema.chattyEvents).where(eq(schema.chattyEvents.userId, userId));
          await db.delete(schema.chattyRuns).where(eq(schema.chattyRuns.userId, userId));
          await db.delete(schema.chattySessions).where(eq(schema.chattySessions.userId, userId));
        }
        if (hostId) await db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
        if (sessionId) await db.delete(schema.adminSessions).where(eq(schema.adminSessions.id, sessionId));
        if (userId) await db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, userId));
        await db.delete(schema.versions).where(eq(schema.versions.name, 'chatty_settings'));
        if (saved.length) await db.insert(schema.versions).values(saved);
        budget.restore();
        await pool.end();
      }
    },
  );
});

import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { runBootMigrations } from '../../../src/ops/boot-migrations.js';
import { OwnedChattyActions } from '../../../src/services/chatty/owner-actions.js';
import { administrationTools, type ToolContext } from '../../../src/services/chatty/tools.js';
import { ChattyStore, type RunState } from '../../../src/services/chatty/store.js';
import { DEFAULT_SETTINGS } from '../../../src/services/chatty/contracts.js';
import { retentionStatus } from '../../../src/services/server-retention/admin.js';
import { RETENTION_POLICY_KEY, RETENTION_RUN_KEY } from '../../../src/services/server-retention/policy.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const config = readDbConfig();
// No connection is opened without the explicit TEST_USE_DB opt-in. This suite
// requires the disposable schema prepared by test:db:setup, never production.
describe.skipIf(!config)('Chatty administration owner on real MySQL', () => {
  it(
    'commits confirmed domain changes with admin receipts, rejects stale/revoked approvals, and rolls back a failed receipt',
    { timeout: 120_000 },
    async () => {
      const pool = mysql.createPool({ ...config!, connectionLimit: 4 });
      const db = drizzle(pool, { schema, mode: 'default' });
      const env = loadTestEnv(),
        keyring = testKeyring();
      const nonce = randomUUID(),
        slug = `chatty-it-${nonce}`;
      const failedSlug = `fail-${nonce}`;
      const trigger = `chatty_receipt_${nonce.replaceAll('-', '')}`;
      const failFlag = `chatty_test_fail_${nonce}`;
      const keys = [
        'chatty_settings',
        'quota_hard_fail',
        'quota_limit_percent',
        'quota_week_partition',
        'quota_advice',
        'quota_policy_codex',
        'quota_policy_claude',
        'quota_policy_grok',
        'usage_scaling_rules',
        'agent_supervisor_enabled',
        RETENTION_POLICY_KEY,
        RETENTION_RUN_KEY,
        failFlag,
      ];
      let saved: (typeof schema.versions.$inferSelect)[] = [];
      let userId: number | undefined, sessionId: number | undefined;
      let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
      let triggerInstalled = false;
      const errors: unknown[] = [];
      try {
        await runBootMigrations(env, pool);
        saved = await db.select().from(schema.versions).where(inArray(schema.versions.name, keys));
        const stamp = new Date().toISOString();
        const [user] = await db.insert(schema.adminUsers).values({
          name: slug,
          username: slug,
          email: `${slug}@example.test`,
          passwordHash: 'test-only',
          accessLevel: 'owner',
          active: 1,
          createdAt: stamp,
          updatedAt: stamp,
        });
        userId = user.insertId;
        const [session] = await db.insert(schema.adminSessions).values({
          userId,
          tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
          createdAt: stamp,
          lastSeenAt: stamp,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        sessionId = session.insertId;
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
        // Fault injection at the persistence boundary: business SQL has run, but
        // the enclosing successful Chatty receipt must still be in that same tx.
        // The trigger exists before acquiring ownership and never writes data.
        await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON chatty_actions FOR EACH ROW
          BEGIN
            IF NEW.user_id = ${userId} AND NEW.tool = 'workflow_create' AND NEW.status = 'succeeded'
              AND EXISTS (SELECT 1 FROM versions WHERE name = '${failFlag}' AND version = '1') THEN
              SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'chatty_test_receipt_failure';
            END IF;
          END`);
        triggerInstalled = true;
        owner = await createOwnedControlPlane({
          pool,
          handle: db,
          env,
          keyring,
          error: (error) => errors.push(error),
        });
        const store = new ChattyStore(db, keyring),
          actor = { userId, sessionId };
        const context: ToolContext = { db, env, keyring, actor };
        const tools = administrationTools();
        const invoked = new Map<string, number>();
        const tracked = tools.map((tool) => ({
          ...tool,
          run: async (c: ToolContext, args: Record<string, unknown>) => {
            invoked.set(tool.name, (invoked.get(tool.name) ?? 0) + 1);
            return tool.run(c, args);
          },
        }));
        const actions = new OwnedChattyActions({ store, tools: tracked, context: () => context });
        const prepare = async (name: string, args: Record<string, unknown>) => {
          await store.session(userId!);
          await store.clear(userId!);
          const conversation = await store.session(userId!);
          const submitted = await store.submit(actor, {
            client_message_id: randomUUID(),
            generation: conversation.generation,
            text: `Confirmed integration operation ${name}`,
          });
          const initial = await store.claim();
          expect(initial?.id).toBe(submitted.id);
          const state: RunState = { messages: [], sources: [] };
          const tool = tracked.find((tool) => tool.name === name)!;
          expect(tool, `registered tool ${name}`).toBeDefined();
          expect(tool.confirm).toBe(true);
          const beforePreparation = invoked.get(name) ?? 0;
          await actions.prepare(initial!, tool, tool.parse(args), state, 0);
          const action = owner!.runtime.state
            .snapshot()
            .table('chattyActions')
            .all()
            .find((row) => row.runId === initial!.id)!;
          expect(action.status).toBe('pending');
          expect(invoked.get(name) ?? 0).toBe(beforePreparation);
          await actions.decide(actor, action.id, true, conversation.generation);
          const run = await store.claim();
          expect(run?.id).toBe(initial!.id);
          return { action, run: run!, state, tool };
        };
        const execute = async (name: string, args: Record<string, unknown>) => {
          const before = invoked.get(name) ?? 0;
          const prepared = await prepare(name, args);
          await actions.perform(prepared.run, prepared.action.id, prepared.state);
          const [durable] = await db
            .select()
            .from(schema.chattyActions)
            .where(eq(schema.chattyActions.id, prepared.action.id));
          expect(durable?.status).toBe('succeeded');
          expect(durable?.resultEnc).toBeTruthy();
          const decoded = store.open<{ status: string; tool: string }>(durable!.resultEnc!);
          expect(decoded).toMatchObject({ status: 'succeeded', tool: name });
          const [receipt] = await db
            .select()
            .from(schema.controlPlaneCommandReceipts)
            .where(
              and(
                eq(schema.controlPlaneCommandReceipts.principal, `admin:${userId}`),
                eq(schema.controlPlaneCommandReceipts.requestId, prepared.action.id),
              ),
            );
          expect(receipt?.replayClass).toBe('external');
          expect(receipt?.resultState).toBe('available');
          expect(prepared.state.messages).toHaveLength(1);
          await actions.perform(prepared.run, prepared.action.id, prepared.state);
          expect(invoked.get(name)).toBe(before + 1);
          expect(prepared.state.messages).toHaveLength(1);
          return prepared;
        };
        const workflowDocument = {
          schema_version: 1,
          title: 'Integration workflow',
          summary: 'Test',
          goal: {
            statement: 'Verify owner composition',
            success_criteria: [{ id: 'atomic', text: 'Receipts and data commit together' }],
          },
          inputs: [],
          knowledge: [],
          tasks: [
            {
              id: 'check',
              title: 'Check',
              instructions: 'Verify the state',
              acceptance_criteria: ['Confirmed'],
              depends_on: [],
              knowledge_ids: [],
            },
          ],
        };
        await execute('workflow_create', {
          client_request_id: randomUUID(),
          slug,
          document: workflowDocument,
          reason: 'Explicit integration test',
        });
        const [workflow] = await db.select().from(schema.workflows).where(eq(schema.workflows.slug, slug));
        expect(workflow?.title).toBe('Integration workflow');
        const [version] = await db
          .select()
          .from(schema.workflowVersions)
          .where(eq(schema.workflowVersions.workflowId, workflow!.id));
        expect(version?.actor).toMatchObject({ kind: 'admin', id: String(userId) });
        expect(version?.document).toEqual(workflowDocument);
        await execute('workflow_revise', {
          client_request_id: randomUUID(),
          workflow_id: workflow!.id,
          expected_workflow_version: 1,
          document: { ...workflowDocument, title: 'Revised integration workflow' },
          reason: 'Verify immutable revision composition',
        });
        expect(owner.runtime.state.snapshot().table('workflows').get(workflow!.id)).toMatchObject({
          currentVersion: 2,
          controlVersion: 2,
          title: 'Revised integration workflow',
        });
        await execute('workflow_archive', {
          client_request_id: randomUUID(),
          workflow_id: workflow!.id,
          expected_workflow_version: 2,
          expected_control_version: 2,
          reason: 'Archive test definition',
        });
        expect(
          (await db.select().from(schema.workflows).where(eq(schema.workflows.id, workflow!.id)))[0],
        ).toMatchObject({ status: 'archived', controlVersion: 3 });
        await execute('workflow_restore', {
          client_request_id: randomUUID(),
          workflow_id: workflow!.id,
          expected_workflow_version: 2,
          expected_control_version: 3,
          reason: 'Restore test definition',
        });
        expect(
          (await db.select().from(schema.workflows).where(eq(schema.workflows.id, workflow!.id)))[0],
        ).toMatchObject({ status: 'active', controlVersion: 4 });
        await execute('workflow_revert', {
          client_request_id: randomUUID(),
          workflow_id: workflow!.id,
          expected_workflow_version: 2,
          version: 1,
          reason: 'Publish the initial document as a new version',
        });
        expect(
          (await db.select().from(schema.workflows).where(eq(schema.workflows.id, workflow!.id)))[0],
        ).toMatchObject({ currentVersion: 3, controlVersion: 5, title: 'Integration workflow' });
        const revisions = await db
          .select()
          .from(schema.workflowVersions)
          .where(eq(schema.workflowVersions.workflowId, workflow!.id));
        expect(revisions).toHaveLength(3);
        expect(revisions.find((revision) => revision.version === 1)?.document).toEqual(workflowDocument);
        expect(revisions.find((revision) => revision.version === 3)?.document).toEqual(workflowDocument);

        await execute('role_create', {
          slug,
          display_name: 'Integration role',
          summary: 'Explicit operator configuration',
        });
        const [role] = await db.select().from(schema.agentRoles).where(eq(schema.agentRoles.slug, slug));
        expect(role).toMatchObject({ displayName: 'Integration role', currentVersionId: null, version: 1 });
        await execute('role_update', {
          slug,
          expected_version: 1,
          summary: 'Updated operator configuration',
          policy: { mutation: 'frozen' },
        });
        expect(
          (await db.select().from(schema.agentRoles).where(eq(schema.agentRoles.slug, slug)))[0],
        ).toMatchObject({
          summary: 'Updated operator configuration',
          version: 2,
          policy: { mutation: 'frozen' },
        });
        const quotaPolicy = {
          unlimited: false,
          short_warn_percent: 79,
          long_warn_percent: 88,
          short_auto_resume: false,
          long_auto_resume: false,
        };
        for (const engine of ['codex', 'claude', 'grok']) {
          await execute('quota_policy_update', { engine, policy: quotaPolicy });
          expect(
            JSON.parse(
              (
                await db
                  .select()
                  .from(schema.versions)
                  .where(eq(schema.versions.name, `quota_policy_${engine}`))
              )[0]!.version!,
            ),
          ).toEqual(quotaPolicy);
        }
        await execute('quota_policy_update', { engine: 'codex', policy: null });
        expect(
          await db.select().from(schema.versions).where(eq(schema.versions.name, 'quota_policy_codex')),
        ).toEqual([]);
        const scaling = {
          enabled: true,
          tiers: [
            { at_percent: 90, reasoning_effort: 'low', model: 'gpt-6-luna' },
            { at_percent: 65, reasoning_effort: 'medium' },
          ],
        };
        await execute('quota_scaling_update', scaling);
        expect(
          JSON.parse(
            (
              await db.select().from(schema.versions).where(eq(schema.versions.name, 'usage_scaling_rules'))
            )[0]!.version!,
          ),
        ).toEqual({ enabled: true, tiers: [scaling.tiers[1], scaling.tiers[0]] });
        // No host work or recovery is seeded. Exercise only fleet configuration.
        expect(owner.runtime.state.snapshot().table('agentWorkStates').all()).toEqual([]);
        const watchdogsBefore = owner.runtime.state.snapshot().table('agentWatchdogs').all();
        for (const enabled of [true, false]) {
          await execute('supervisor_state_set', { enabled });
          expect(
            (
              await db
                .select()
                .from(schema.versions)
                .where(eq(schema.versions.name, 'agent_supervisor_enabled'))
            )[0]?.version,
          ).toBe(enabled ? '1' : '0');
          expect(owner.runtime.state.snapshot().table('agentWorkStates').all()).toEqual([]);
          expect(owner.runtime.state.snapshot().table('agentWatchdogs').all()).toEqual(watchdogsBefore);
        }

        await execute('quota_mode_update', { hard_fail: false, limit_percent: 87, week_partition: '5' });
        expect(owner.runtime.state.snapshot().setting('quota_limit_percent')).toBe('87');
        expect(
          (await db.select().from(schema.versions).where(eq(schema.versions.name, 'quota_hard_fail')))[0]
            ?.version,
        ).toBe('0');
        const policy = { audit_days: 33, history_hours: 72, quota_days: 21, armed: true };
        await execute('server_retention_policy_set', {
          policy,
          expected_revision: retentionStatus(db).revision,
        });
        expect(
          JSON.parse(
            (
              await db.select().from(schema.versions).where(eq(schema.versions.name, RETENTION_POLICY_KEY))
            )[0]!.version!,
          ),
        ).toEqual(policy);
        const retentionRequest = randomUUID();
        await execute('server_retention_run', {
          client_request_id: retentionRequest,
          expected_revision: retentionStatus(db).revision,
        });
        expect(retentionStatus(db).run).toMatchObject({ id: retentionRequest, status: 'running' });
        // Admission alone is verified: no maintenance worker or deletion is run.
        const stale = await prepare('quota_mode_update', {
          hard_fail: true,
          limit_percent: 90,
          week_partition: '7',
        });
        const calledBeforeStale = invoked.get('quota_mode_update');
        await mutateOwnerState(owner.runtime, {
          kind: 'test.quota.concurrent',
          payload: {},
          prepare(c) {
            stageUpdate(c, 'versions', 'quota_limit_percent', {
              version: '88',
              updatedAt: new Date().toISOString(),
            });
            return null;
          },
        });
        await expect(actions.perform(stale.run, stale.action.id, stale.state)).rejects.toThrow(
          'Target changed',
        );
        expect(invoked.get('quota_mode_update')).toBe(calledBeforeStale);
        expect(owner.runtime.state.snapshot().setting('quota_limit_percent')).toBe('88');
        const revoked = await prepare('quota_mode_update', {
          hard_fail: true,
          limit_percent: 90,
          week_partition: '7',
        });
        await mutateOwnerState(owner.runtime, {
          kind: 'test.admin.revoke',
          payload: {},
          prepare(c) {
            stageUpdate(c, 'adminUsers', userId!, { active: 0, updatedAt: new Date().toISOString() });
            return null;
          },
        });
        await expect(actions.perform(revoked.run, revoked.action.id, revoked.state)).rejects.toThrow(
          'revoked',
        );
        expect(invoked.get('quota_mode_update')).toBe(calledBeforeStale);
        await mutateOwnerState(owner.runtime, {
          kind: 'test.admin.restore',
          payload: {},
          prepare(c) {
            stageUpdate(c, 'adminUsers', userId!, { active: 1, updatedAt: new Date().toISOString() });
            const row = { name: failFlag, version: '1', updatedAt: new Date().toISOString() };
            c.draft.upsert('versions', row);
            c.write((tx) => tx.insert(schema.versions).values(row));
            return null;
          },
        });
        const failed = await prepare('workflow_create', {
          client_request_id: randomUUID(),
          slug: failedSlug,
          document: workflowDocument,
          reason: 'Inject receipt failure',
        });
        await expect(actions.perform(failed.run, failed.action.id, failed.state)).rejects.toMatchObject({
          cause: { sqlMessage: 'chatty_test_receipt_failure' },
        });
        expect(await db.select().from(schema.workflows).where(eq(schema.workflows.slug, failedSlug))).toEqual(
          [],
        );
        expect(
          owner.runtime.state
            .snapshot()
            .table('workflows')
            .all()
            .some((row) => row.slug === failedSlug),
        ).toBe(false);
        expect(
          (
            await db.select().from(schema.chattyActions).where(eq(schema.chattyActions.id, failed.action.id))
          )[0]?.status,
        ).toBe('unknown');
        expect(
          await db
            .select()
            .from(schema.controlPlaneCommandReceipts)
            .where(
              and(
                eq(schema.controlPlaneCommandReceipts.principal, `admin:${userId}`),
                eq(schema.controlPlaneCommandReceipts.requestId, failed.action.id),
              ),
            ),
        ).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        const epoch = owner?.runtime.state.revision().epoch;
        await owner?.close();
        if (triggerInstalled) await pool.query(`DROP TRIGGER ${trigger}`);
        if (epoch)
          await db
            .delete(schema.controlPlaneCommandReceipts)
            .where(eq(schema.controlPlaneCommandReceipts.ownerEpoch, epoch));
        if (userId) {
          await db.delete(schema.chattyActions).where(eq(schema.chattyActions.userId, userId));
          await db.delete(schema.chattyEvents).where(eq(schema.chattyEvents.userId, userId));
          await db.delete(schema.chattyRuns).where(eq(schema.chattyRuns.userId, userId));
          await db.delete(schema.chattySessions).where(eq(schema.chattySessions.userId, userId));
          await db
            .delete(schema.workflowMutations)
            .where(eq(schema.workflowMutations.actorKey, `admin:${userId}`));
        }
        const definitions = await db
          .select()
          .from(schema.workflows)
          .where(inArray(schema.workflows.slug, [slug, failedSlug]));
        for (const definition of definitions)
          await db
            .delete(schema.workflowVersions)
            .where(eq(schema.workflowVersions.workflowId, definition.id));
        await db.delete(schema.workflows).where(inArray(schema.workflows.slug, [slug, failedSlug]));
        await db.delete(schema.agentRoles).where(eq(schema.agentRoles.slug, slug));
        if (sessionId) await db.delete(schema.adminSessions).where(eq(schema.adminSessions.id, sessionId));
        if (userId) await db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, userId));
        await db.delete(schema.versions).where(inArray(schema.versions.name, keys));
        if (saved.length) await db.insert(schema.versions).values(saved);
        await pool.end();
      }
    },
  );
});

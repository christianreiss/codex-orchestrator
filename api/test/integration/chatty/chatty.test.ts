import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import {
  adminUsers,
  adminSessions,
  chattyRuns,
  chattyActions,
  chattyEvents,
  versions,
  skills,
  clientConfigDocuments,
} from '../../../src/db/schema.js';
import { ChattyStore, now, later } from '../../../src/services/chatty/store.js';
import { ChattyCoordinator } from '../../../src/services/chatty/coordinator.js';
import {
  administrationTools,
  type ChattyTool,
  type ToolContext,
} from '../../../src/services/chatty/tools.js';
import { SkillsService } from '../../../src/services/skills.js';
import { ClientConfigService } from '../../../src/services/client-config.js';
import type { ChattyActor } from '../../../src/services/chatty/contracts.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Chatty durable lifecycle (isolated MySQL)', () => {
  const db = handle ? handle.db : (undefined as never);
  const store = new ChattyStore(db, testKeyring());
  let actor: ChattyActor;
  let other: ChattyActor;
  const created: number[] = [];
  const prefix = `chatty-test-${randomUUID().slice(0, 8)}`;
  async function account(role = 'admin') {
    const username = `${prefix}-${created.length}`;
    const [u] = await db
      .insert(adminUsers)
      .values({
        username,
        email: `${username}@example.invalid`,
        name: username,
        passwordHash: 'unused',
        accessLevel: role,
        active: 1,
        createdAt: now(),
        updatedAt: now(),
      })
      .$returningId();
    created.push(u!.id);
    const [s] = await db
      .insert(adminSessions)
      .values({
        userId: u!.id,
        tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        createdAt: now(),
        lastSeenAt: now(),
        expiresAt: later(3600000),
      })
      .$returningId();
    await store.session(u!.id);
    return { userId: u!.id, sessionId: s!.id };
  }
  const input = (text = 'Bitte prüfen') => ({ client_message_id: randomUUID(), generation: 1, text });
  beforeAll(async () => {
    actor = await account();
    other = await account();
  });
  beforeEach(async () => {
    for (const userId of created) {
      await db.delete(chattyEvents).where(eq(chattyEvents.userId, userId));
      await db.delete(chattyActions).where(eq(chattyActions.userId, userId));
      await db.delete(chattyRuns).where(eq(chattyRuns.userId, userId));
    }
  });
  afterAll(async () => {
    for (const id of created) {
      await db.delete(adminSessions).where(eq(adminSessions.userId, id));
      await db.delete(adminUsers).where(eq(adminUsers.id, id));
    }
    await db.delete(versions).where(eq(versions.name, prefix));
    await handle!.pool.end();
  });
  it('encrypts conversation content, isolates users, and deduplicates concurrent delivery', async () => {
    const request = input('Vertraulicher Testinhalt');
    const [a, b] = await Promise.all([store.submit(actor, request), store.submit(actor, request)]);
    expect(a.id).toBe(b.id);
    const rows = await db.select().from(chattyRuns).where(eq(chattyRuns.userId, actor.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputEnc).toMatch(/^sbox:v1/);
    expect(rows[0]!.inputEnc).not.toContain(request.text);
    expect(await store.events(other.userId, 1)).toEqual([]);
    await expect(store.submit(actor, { ...request, text: 'changed' })).rejects.toThrow('different request');
    await expect(store.cancel(other.userId, a.id)).rejects.toThrow('not found');
  });
  it('serializes different messages from concurrent tabs', async () => {
    const results = await Promise.allSettled([store.submit(actor, input()), store.submit(actor, input())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('limits simultaneous claims and never replays an expired claim', async () => {
    const request = await store.submit(actor, input());
    const claims = await Promise.all([store.claim(), store.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await db
      .update(chattyRuns)
      .set({ leaseUntil: '2000-01-01T00:00:00.000Z' })
      .where(eq(chattyRuns.id, request.id));
    expect(await store.claim()).toBeNull();
    expect((await db.select().from(chattyRuns).where(eq(chattyRuns.id, request.id)))[0]!.status).toBe(
      'unknown',
    );
  });
  it('rejects viewer access and session revocation, including compatible authorization mode', async () => {
    const viewer = await account('viewer');
    await expect(store.submit(viewer, input())).rejects.toThrow('revoked');
    const user = await account();
    await store.submit(user, input());
    const run = await store.claim();
    await db.delete(adminSessions).where(eq(adminSessions.id, user.sessionId));
    await expect(store.current(run!)).rejects.toThrow('revoked');
  });
  it('does not overwrite a concurrent cancellation when sweeping expired claims', async () => {
    const request = await store.submit(actor, input());
    await store.claim();
    await db
      .update(chattyRuns)
      .set({ leaseUntil: '2000-01-01T00:00:00.000Z' })
      .where(eq(chattyRuns.id, request.id));
    let sweep: Promise<unknown>;
    await db.transaction(async (tx) => {
      await tx
        .update(chattyRuns)
        .set({ status: 'cancelled', claimId: null })
        .where(eq(chattyRuns.id, request.id));
      sweep = store.claim();
      // Let the second connection reach its read while this cancellation is uncommitted.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await sweep!;
    expect((await db.select().from(chattyRuns).where(eq(chattyRuns.id, request.id)))[0]!.status).toBe(
      'cancelled',
    );
    expect((await store.events(actor.userId, 1)).some((event) => event.body.status === 'unknown')).toBe(
      false,
    );
  });
  it('fences cleared generations and deletes encrypted payloads while retaining retry tombstones', async () => {
    const user = await account();
    const request = input();
    await store.submit(user, request);
    const run = await store.claim();
    expect(await store.clear(user.userId)).toEqual({ generation: 2 });
    await expect(store.update(run!, { messages: [], sources: [] }, 'succeeded', 0)).rejects.toThrow();
    await expect(store.submit(user, request)).rejects.toThrow('cleared');
    expect(await store.events(user.userId, 1)).toEqual([]);
    const row = (await db.select().from(chattyRuns).where(eq(chattyRuns.userId, user.userId)))[0]!;
    expect(store.open(row.inputEnc)).toBeNull();
    expect(store.open(row.stateEnc)).toBeNull();
  });
  function coordinator(tool: ChattyTool | ChattyTool[], responses: unknown[]) {
    const inference = {
      availability: vi.fn().mockResolvedValue([
        {
          engine: 'codex',
          ready: true,
          reason: null,
          models: [{ id: 'test', display_name: 'Test' }],
          default_model: 'test',
        },
      ]),
      run: vi.fn(async () => ({
        response: responses.shift() ?? { kind: 'answer', text: 'Fertig', sources: [] },
        engine: 'codex',
        model: 'test',
      })),
    };
    return new ChattyCoordinator(
      { db, keyring: testKeyring(), env: loadTestEnv() },
      {
        inference: inference as never,
        tools: Array.isArray(tool) ? tool : [tool],
        knowledge: { version: 'test', sources: [] },
      },
    );
  }
  const tool: ChattyTool = {
    name: 'test_update',
    description: 'Change a test setting',
    capability: 'settings.manage',
    write: true,
    confirm: true,
    parameters: {},
    parse: (args) => args as Record<string, unknown>,
    snapshot: async (c) =>
      (await c.db.select().from(versions).where(eq(versions.name, prefix)).for('update'))[0]?.version ?? null,
    run: async (c) => {
      await c.db
        .insert(versions)
        .values({ name: prefix, version: 'after', updatedAt: now() })
        .onDuplicateKeyUpdate({ set: { version: 'after' } });
      return { value: 'after' };
    },
  };
  async function waitFor(id: string, status: string) {
    await vi.waitFor(
      async () =>
        expect((await db.select().from(chattyRuns).where(eq(chattyRuns.id, id)))[0]!.status).toBe(status),
      { timeout: 5000, interval: 20 },
    );
  }
  it('requires a concrete confirmation and records the domain change with its receipt atomically', async () => {
    await db.delete(versions).where(eq(versions.name, prefix));
    const co = coordinator(tool, [{ kind: 'tool_call', name: tool.name, arguments: {} }]);
    const request = await store.submit(actor, input('Ändern'));
    await co.tick();
    await waitFor(request.id, 'waiting_confirmation');
    const action = (await db.select().from(chattyActions).where(eq(chattyActions.runId, request.id)))[0]!;
    expect(await db.select().from(versions).where(eq(versions.name, prefix))).toEqual([]);
    await expect(co.decide(other, action.id, true, 1)).rejects.toThrow();
    await co.decide(actor, action.id, true, 1);
    await co.tick();
    await waitFor(request.id, 'succeeded');
    expect((await db.select().from(versions).where(eq(versions.name, prefix)))[0]!.version).toBe('after');
    expect((await db.select().from(chattyActions).where(eq(chattyActions.id, action.id)))[0]!.status).toBe(
      'succeeded',
    );
    await expect(co.decide(actor, action.id, true, 1)).rejects.toThrow();
  });
  it('rejects a confirmed mutation when its target changed after preparation', async () => {
    await db.delete(versions).where(eq(versions.name, prefix));
    const co = coordinator(tool, [{ kind: 'tool_call', name: tool.name, arguments: {} }]);
    const request = await store.submit(actor, input('Ändern'));
    await co.tick();
    await waitFor(request.id, 'waiting_confirmation');
    await db.insert(versions).values({ name: prefix, version: 'concurrent', updatedAt: now() });
    const action = (await db.select().from(chattyActions).where(eq(chattyActions.runId, request.id)))[0]!;
    await co.decide(actor, action.id, true, 1);
    await co.tick();
    await waitFor(request.id, 'failed');
    expect((await db.select().from(versions).where(eq(versions.name, prefix)))[0]!.version).toBe(
      'concurrent',
    );
    expect((await db.select().from(chattyActions).where(eq(chattyActions.id, action.id)))[0]!.status).toBe(
      'failed',
    );
  });
  it('rolls back a failed mutation and keeps its receipt separate from success', async () => {
    const broken = {
      ...tool,
      confirm: false,
      run: async (c: Parameters<ChattyTool['run']>[0]) => {
        await c.db.update(versions).set({ version: 'rolled-back' }).where(eq(versions.name, prefix));
        throw new Error('failure after write');
      },
    };
    const co = coordinator(broken, [{ kind: 'tool_call', name: tool.name, arguments: {} }]);
    const request = await store.submit(actor, input('Ändern'));
    await co.tick();
    await waitFor(request.id, 'failed');
    expect((await db.select().from(versions).where(eq(versions.name, prefix)))[0]!.version).toBe(
      'concurrent',
    );
    expect(
      await db
        .select()
        .from(chattyActions)
        .where(and(eq(chattyActions.runId, request.id), eq(chattyActions.status, 'succeeded'))),
    ).toEqual([]);
  });
  it('persists seen-available across subsequent access loss', async () => {
    const user = await account();
    const co = coordinator(tool, []);
    expect((await co.status(user.userId)).visible).toBe(true);
    vi.mocked(co.inference.availability).mockResolvedValue([
      { engine: 'codex', ready: false, reason: 'runner_unavailable', models: [], default_model: null },
    ]);
    expect(await co.status(user.userId)).toMatchObject({ visible: true, ready: false });
  });
  it('authors a real fleet skill after a complete manager read, and fences partial replacements', async () => {
    const manager = (await new SkillsService(db).find('skill-manager'))!;
    const manifest = '# Test\n' + 'Complete original section.\n'.repeat(400);
    const call = (name: string, args: Record<string, unknown>) => ({
      kind: 'tool_call',
      name,
      arguments: args,
    });
    const responses = [call('skills_search', { query: prefix })];
    for (let offset = 0; offset < manager.manifest.length; offset += 8000)
      responses.push(call('skill_read', { slug: 'skill-manager', offset }));
    responses.push(call('skill_store', { slug: prefix, manifest, expected_sha256: null }));
    const co = coordinator(administrationTools(), responses);
    const first = await store.submit(actor, input('Erstelle einen Test-Skill'));
    try {
      await co.tick();
      await waitFor(first.id, 'succeeded');
      const saved = (await new SkillsService(db).find(prefix))!;
      expect(saved.manifest).toBe(manifest);
      // A later replacement reads only the first window of this long skill.
      responses.push(call('skills_search', { query: prefix }));
      for (let offset = 0; offset < manager.manifest.length; offset += 8000)
        responses.push(call('skill_read', { slug: 'skill-manager', offset }));
      responses.push(call('skill_read', { slug: prefix, offset: 0 }));
      responses.push(
        call('skill_store', {
          slug: prefix,
          manifest: 'Truncated replacement',
          expected_sha256: saved.sha256,
        }),
      );
      const second = await store.submit(actor, input('Ändere den Skill'));
      await co.tick();
      await waitFor(second.id, 'succeeded');
      expect((await new SkillsService(db).find(prefix))!.manifest).toBe(manifest);
      expect(
        (await store.events(actor.userId, 1)).some((e) =>
          String(e.body.text).includes('complete current document'),
        ),
      ).toBe(true);
    } finally {
      co.stop();
      await db.delete(skills).where(eq(skills.slug, prefix));
    }
  });
  it('keeps hidden MCP credentials when patching public configuration fields', async () => {
    const service = new ClientConfigService(db);
    const ctx = { db, keyring: testKeyring(), env: loadTestEnv(), actor } as ToolContext;
    const tools = administrationTools();
    try {
      await service.store(
        {
          settings: {
            mcp_servers: [
              {
                name: 'chatty-test',
                url: 'https://example.invalid/mcp',
                http_headers: { 'X-Custom': 'test-only-secret' },
              },
            ],
          },
        },
        null,
        'codex',
      );
      const current = await service.adminFetch('codex');
      const view = await tools.find((t) => t.name === 'config_read')!.run(ctx, { engine: 'codex' });
      expect(JSON.stringify(view)).not.toContain('test-only-secret');
      await tools
        .find((t) => t.name === 'config_store')!
        .run(ctx, {
          engine: 'codex',
          expected_sha256: current.sha256,
          settings: { mcp_servers: [{ name: 'chatty-test', url: 'https://example.invalid/new' }] },
        });
      const updated = await service.adminFetch('codex');
      expect(JSON.stringify(updated.settings)).toContain('test-only-secret');
      expect(JSON.stringify(updated.settings)).toContain('https://example.invalid/new');
    } finally {
      await db.delete(clientConfigDocuments).where(eq(clientConfigDocuments.engine, 'codex'));
    }
  });
});

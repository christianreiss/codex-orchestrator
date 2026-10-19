import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { eq, inArray, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminEvents, feedbackItems, feedbackEvents, versions } from '../../src/db/schema.js';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { FeedbackService } from '../../src/services/feedback.js';
import { McpToolsRegistry, type ToolDeps } from '../../src/services/mcp-tools.js';
import { wsPublisher } from '../../src/ws/publisher.js';
import { registerAdminFeedbackRoutes } from '../../src/routes/admin/feedback/index.js';
import { makeCapabilitiesPlugin } from '../../src/http/plugins/capabilities.js';
import type { AdminContext } from '../../src/http/plugins/auth-admin.js';
import { UnauthorizedError } from '../../src/http/errors.js';
import { getTestDb } from '../helpers/test-db.js';
import { testKeyring, loadTestEnv } from '../helpers/test-keyring.js';
import type { FeedbackActor } from '../../src/services/feedback-contract.js';
import type { Host } from '../../src/db/schema.js';

const handle = await getTestDb();
const actor: FeedbackActor = { host_id: 700, engine: 'codex' };
const other: FeedbackActor = { host_id: 701, engine: 'claude' };
const admin: FeedbackActor = { host_id: null, engine: null, admin_user_id: 1 };

describe.skipIf(!handle)('central feedback with real MySQL', () => {
  if (!handle) return;
  const db = handle!.db;
  const service = new FeedbackService(db, testKeyring());
  let ids: string[] = [];
  let oldFlag: typeof versions.$inferSelect | undefined;
  const report = () => ({ client_request_id: randomUUID(), type: 'bug', title: 'feedback test', description: 'Reproduce a wrapper error', component: 'wrapper' });
  async function submit(extra: Record<string, unknown> = {}) {
    const result = await service.submit({ ...report(), ...extra }, actor);
    ids.push(result.feedback.id);
    return result.feedback;
  }
  async function acquire(id: string, who = actor) {
    return service.claim({ id, action: 'acquire', client_request_id: randomUUID() }, who);
  }
  beforeAll(async () => {
    [oldFlag] = await db.select().from(versions).where(eq(versions.name, 'feedback_enabled'));
  });
  beforeEach(async () => { await service.setEnabled(true); });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (ids.length) {
      await db.delete(feedbackEvents).where(inArray(feedbackEvents.feedbackId, ids));
      await db.delete(feedbackItems).where(inArray(feedbackItems.id, ids));
    }
    ids = [];
  });
  afterAll(async () => {
    await db.delete(versions).where(eq(versions.name, 'feedback_enabled'));
    if (oldFlag) await db.insert(versions).values(oldFlag);
    await handle!.pool.end();
  });

  it('counts unhandled reports for the console indicator', async () => {
    const before = await service.summary(admin);
    const first = await submit();
    await submit();
    expect(await service.summary(admin)).toEqual({ ...before, open: before.open + 2 });
    await acquire(first.id);
    expect(await service.summary(admin)).toEqual({ ...before, open: before.open + 1, in_progress: before.in_progress + 1 });
  });

  it('applies migration twice without destroying data', async () => {
    const row = await submit();
    const raw = await readFile(new URL('../../src/db/migrations/0061_feedback.sql', import.meta.url), 'utf8');
    for (let run = 0; run < 2; run++) for (const statement of splitSqlStatements(raw)) await handle!.pool.query(statement);
    expect((await service.get(row.id, actor)).feedback.id).toBe(row.id);
  });

  it('atomically deduplicates simultaneous submission retries and rejects changed payloads', async () => {
    const input = report();
    const results = await Promise.all([service.submit(input, actor), service.submit(input, actor)]);
    ids.push(results[0]!.feedback.id);
    expect(results[0]!.feedback.id).toBe(results[1]!.feedback.id);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    await expect(service.submit({ ...input, description: 'Changed' }, actor)).rejects.toThrow('different feedback');
    expect((await service.get(ids[0], actor)).events).toHaveLength(1);
  });

  it('scopes request IDs to authenticated sources', async () => {
    const input = report();
    const a = await service.submit(input, actor);
    const b = await service.submit(input, other);
    ids.push(a.feedback.id, b.feedback.id);
    expect(a.feedback.id).not.toBe(b.feedback.id);
    expect(b.feedback.source).toMatchObject(other);
  });

  it('filters, searches literal wildcard characters and paginates priority order', async () => {
    const low = await submit({ priority: 'low', title: 'Percent % issue' });
    const high = await submit({ priority: 'high' });
    const critical = await submit({ priority: 'critical', type: 'feature', description: 'Missing telemetry view' });
    const first = await service.list({ component: 'wrapper', limit: 1 }, actor);
    expect(first.feedback[0]!.id).toBe(critical.id);
    expect(first.feedback[0]).not.toHaveProperty('report');
    expect(first.feedback[0]).not.toHaveProperty('result');
    expect(first.next_offset).toBe(1);
    expect((await service.list({ component: 'wrapper', limit: 1, offset: 1 }, actor)).feedback[0]!.id).toBe(high.id);
    expect((await service.list({ query: '%' }, actor)).feedback.map((r) => r.id)).toEqual([low.id]);
    expect((await service.list({ type: 'feature', query: 'telemetry' }, actor)).feedback.map((r) => r.id)).toEqual([critical.id]);
  });

  it('grants only one of two concurrent claims, including on the same host', async () => {
    const row = await submit();
    const results = await Promise.allSettled([acquire(row.id), acquire(row.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await service.get(row.id, actor)).events.map((e) => e.action)).toEqual(['submitted', 'claimed']);
  });

  it('replays an acquire response with its token and never exposes tokens through reads/history', async () => {
    const row = await submit();
    const args = { id: row.id, action: 'acquire', client_request_id: randomUUID() };
    const claimed = await service.claim(args, actor);
    const retry = await service.claim(args, actor);
    expect(retry.claim_token).toBe(claimed.claim_token);
    expect(retry.replayed).toBe(true);
    const read = await service.get(row.id, actor);
    expect(JSON.stringify(read)).not.toContain(claimed.claim_token!);
    const [stored] = await db.select().from(feedbackItems).where(eq(feedbackItems.id, row.id));
    expect(stored!.claimTokenEnc).toMatch(/^sbox:v1:/);
    expect(stored!.claimTokenHash).not.toBe(claimed.claim_token);
  });

  it('rejects tokens from another host or engine and permits only holder renewal/release', async () => {
    const row = await submit();
    const claimed = await acquire(row.id);
    const args = { id: row.id, action: 'renew', claim_token: claimed.claim_token };
    await expect(service.claim(args, other)).rejects.toThrow('Live claim token');
    await expect(service.claim(args, { ...actor, engine: 'grok' })).rejects.toThrow('Live claim token');
    const renewed = await service.claim(args, actor);
    expect(renewed.feedback.version).toBe(claimed.feedback.version + 1);
    const released = await service.claim({ ...args, action: 'release' }, actor);
    expect(released.feedback.status).toBe('open');
    const newClaim = await acquire(row.id, other);
    await expect(service.claim(args, actor)).rejects.toThrow('Live claim token');
    expect(newClaim.claim_token).not.toBe(claimed.claim_token);
  });

  it('reopens expired claims on access and fences old tokens', async () => {
    const row = await submit();
    const claimed = await acquire(row.id);
    await db.update(feedbackItems).set({ claimExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(feedbackItems.id, row.id));
    expect((await service.list({ status: 'open' }, actor)).feedback.map((r) => r.id)).toContain(row.id);
    await expect(service.update({ id: row.id, expected_version: claimed.feedback.version + 1, claim_token: claimed.claim_token, note: 'old holder' }, actor)).rejects.toThrow('Claim expired');
    const read = await service.get(row.id, actor);
    expect(read.feedback.claim_owner).toBeNull();
    expect(read.events.at(-1)!.action).toBe('claim_expired');
  });

  it('allows other agents to contribute evidence without taking over a live claim', async () => {
    const row = await submit();
    const claimed = await acquire(row.id);
    const added = await service.update({ id: row.id, expected_version: claimed.feedback.version, note: 'Also reproduced on Claude' }, other);
    expect(added.feedback.status).toBe('in_progress');
    await expect(service.update({ id: row.id, expected_version: added.feedback.version, title: 'overwrite' }, other)).rejects.toThrow('Live claim token');
  });

  it('turns concurrent updates into one version conflict', async () => {
    const row = await submit();
    const results = await Promise.allSettled([
      service.update({ id: row.id, expected_version: row.version, note: 'A' }, actor),
      service.update({ id: row.id, expected_version: row.version, note: 'B' }, other),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await service.get(row.id, actor)).events).toHaveLength(2);
  });

  it('requires a claim and complete evidence to resolve; records deployment separately', async () => {
    const row = await submit();
    await expect(service.update({ id: row.id, expected_version: 1, status: 'resolved' }, actor)).rejects.toThrow('Live claim token');
    const claimed = await acquire(row.id);
    const base = { id: row.id, expected_version: claimed.feedback.version, claim_token: claimed.claim_token, status: 'resolved' };
    await expect(service.update(base, actor)).rejects.toThrow('verification');
    const closed = await service.update({ ...base, resolution: 'Fixed the parser', fix_ref: 'commit:test', verification: 'Regression test passed' }, actor);
    expect(closed.feedback.deployment).toBe('not_deployed');
    expect(closed.feedback.claim_owner).toBeNull();
    await expect(acquire(row.id)).rejects.toThrow('Reopen');
    await expect(service.update({ id: row.id, expected_version: closed.feedback.version, deployment: 'deployed' }, admin)).rejects.toThrow('deployment_ref');
    const deployed = await service.update({ id: row.id, expected_version: closed.feedback.version, deployment: 'deployed', deployment_ref: 'release:test' }, admin);
    expect(deployed.feedback.status).toBe('resolved');
    const reopened = await service.update({ id: row.id, expected_version: deployed.feedback.version, status: 'open' }, admin);
    expect(reopened.feedback.result).toBeNull();
    expect(reopened.feedback.deployment).toBe('unknown');
    expect((await service.get(row.id, actor)).events.some((e) => e.detail.fix_ref === 'commit:test')).toBe(true);
  });

  it('preserves original reports when triaging metadata', async () => {
    const row = await submit();
    const changed = await service.update({ id: row.id, expected_version: row.version, title: 'Corrected title', type: 'feature' }, actor);
    expect(changed.feedback.report?.title).toBe('feedback test');
    expect(changed.feedback.title).toBe('Corrected title');
  });

  it.each(['blocked', 'dismissed'])('%s requires a reason and releases the claim', async (status) => {
    const row = await submit();
    const claimed = await acquire(row.id);
    const args = { id: row.id, expected_version: claimed.feedback.version, claim_token: claimed.claim_token, status };
    await expect(service.update(args, actor)).rejects.toThrow('requires reason');
    const changed = await service.update({ ...args, reason: 'Needs a reproducible trace' }, actor);
    expect(changed.feedback.status).toBe(status);
    expect(changed.feedback.claim_owner).toBeNull();
  });

  it('validates duplicate targets and keeps canonical reports canonical', async () => {
    const canonical = await submit();
    const duplicate = await submit();
    await expect(service.update({ id: duplicate.id.toUpperCase(), expected_version: 1, status: 'duplicate', duplicate_of: duplicate.id }, admin)).rejects.toThrow('another feedback');
    await expect(service.update({ id: duplicate.id, expected_version: 1, status: 'duplicate', duplicate_of: randomUUID() }, admin)).rejects.toThrow('existing canonical');
    await service.update({ id: duplicate.id, expected_version: 1, status: 'duplicate', duplicate_of: canonical.id }, admin);
    await expect(service.update({ id: canonical.id, expected_version: 1, status: 'duplicate', duplicate_of: duplicate.id }, admin)).rejects.toThrow('canonical');
    const third = await submit();
    await expect(service.update({ id: canonical.id, expected_version: 1, status: 'duplicate', duplicate_of: third.id }, admin)).rejects.toThrow('referenced by duplicates');
  });

  it('prevents concurrent duplicate cycles', async () => {
    const a = await submit();
    const b = await submit();
    const results = await Promise.allSettled([
      service.update({ id: a.id, expected_version: 1, status: 'duplicate', duplicate_of: b.id }, admin),
      service.update({ id: b.id, expected_version: 1, status: 'duplicate', duplicate_of: a.id }, admin),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rows = await db.select().from(feedbackItems).where(inArray(feedbackItems.id, [a.id, b.id]));
    expect(rows.filter((r) => r.status === 'duplicate')).toHaveLength(1);
  });

  it('allows administrative release while disabled but rejects agent calls', async () => {
    const row = await submit();
    const claimed = await acquire(row.id);
    await expect(service.claim({ id: row.id, action: 'force_release', reason: 'handoff' }, actor)).rejects.toThrow('Administrative');
    await service.setEnabled(false);
    await expect(service.list({}, actor)).rejects.toThrow('disabled');
    await expect(service.claim({ id: row.id, action: 'renew', claim_token: claimed.claim_token }, actor)).rejects.toThrow('disabled');
    const released = await service.claim({ id: row.id, action: 'force_release', reason: 'operator handoff' }, admin);
    expect(released.feedback.status).toBe('open');
    expect((await service.get(row.id, admin)).events.at(-1)!.action).toBe('claim_force_released');
  });

  it('rolls back both item and event if event persistence fails; publishes only committed changes', async () => {
    const row = await submit();
    const published = vi.spyOn(wsPublisher, 'publish');
    const event = vi.spyOn(service as unknown as { event: (...args: unknown[]) => Promise<void> }, 'event').mockRejectedValueOnce(new Error('event unavailable'));
    await expect(service.update({ id: row.id, expected_version: 1, title: 'lost change' }, admin)).rejects.toThrow('event unavailable');
    event.mockRestore();
    const read = await service.get(row.id, actor);
    expect(read.feedback.title).toBe(row.title);
    expect(read.feedback.version).toBe(1);
    expect(read.events).toHaveLength(1);
    expect(published).not.toHaveBeenCalled();
  });

  async function close(id: string, status: 'resolved' | 'dismissed' | 'duplicate', extra: Record<string, unknown> = {}) {
    const current = (await service.get(id, admin)).feedback;
    const outcome = status === 'resolved' ? { resolution: 'r', fix_ref: 'commit:x', verification: 'v' } : status === 'dismissed' ? { reason: 'noise' } : {};
    return (await service.update({ id, expected_version: current.version, status, ...outcome, ...extra }, admin)).feedback;
  }
  const exists = async (id: string) => (await db.select({ id: feedbackItems.id }).from(feedbackItems).where(eq(feedbackItems.id, id))).length > 0;
  const eventCount = async (id: string) => (await db.select({ id: feedbackEvents.id }).from(feedbackEvents).where(eq(feedbackEvents.feedbackId, id))).length;

  it('deletes only closed items, with history and duplicates, and audits in the same transaction', async () => {
    const open = await submit();
    const blocked = await submit();
    await service.update({ id: blocked.id, expected_version: 1, status: 'blocked', reason: 'waiting' }, admin);
    const claimed = await submit();
    await acquire(claimed.id);
    for (const row of [open, blocked, claimed]) {
      await expect(service.remove(row.id, admin)).rejects.toMatchObject({ status: 409 });
      expect(await exists(row.id)).toBe(true);
    }
    await expect(service.remove(open.id, actor)).rejects.toThrow('administrators');

    const canonical = await submit();
    const dup = await submit();
    await close(dup.id, 'duplicate', { duplicate_of: canonical.id });
    await close(canonical.id, 'resolved');
    const published = vi.spyOn(wsPublisher, 'publish');
    const result = await service.remove(canonical.id, admin);
    expect(result).toMatchObject({ deleted: 2, cascaded_duplicates: 1, by_status: { resolved: 1, duplicate: 1 } });
    expect(result.events).toBeGreaterThanOrEqual(4);
    for (const id of [canonical.id, dup.id]) { expect(await exists(id)).toBe(false); expect(await eventCount(id)).toBe(0); }
    expect(published).toHaveBeenCalledWith('feedback.changed', { id: canonical.id });
    const [audit] = await db.select().from(adminEvents).where(eq(adminEvents.type, 'feedback.deleted')).orderBy(sql`id DESC`).limit(1);
    expect(audit!.payload).toMatchObject({ id: canonical.id, deleted: 2, admin_user_id: 1 });
    await expect(service.remove(canonical.id, admin)).rejects.toMatchObject({ status: 404 });
  });

  it('rolls back a delete when the audit insert fails', async () => {
    const row = await submit();
    await close(row.id, 'dismissed');
    const spy = vi.spyOn(service as unknown as { purgeRows: (...a: unknown[]) => Promise<unknown> }, 'purgeRows');
    spy.mockImplementationOnce(async (tx: unknown) => {
      await (tx as typeof db).delete(feedbackEvents).where(eq(feedbackEvents.feedbackId, row.id));
      throw new Error('audit unavailable');
    });
    await expect(service.remove(row.id, admin)).rejects.toThrow('audit unavailable');
    expect(await eventCount(row.id)).toBeGreaterThan(0);
  });

  it('purges by closed status and age, cascading duplicates of purged canonicals', async () => {
    const oldResolved = await submit();
    const newResolved = await submit();
    const dismissed = await submit();
    const stillOpen = await submit();
    const dupOfOld = await submit();
    await close(dupOfOld.id, 'duplicate', { duplicate_of: oldResolved.id });
    await close(oldResolved.id, 'resolved');
    await close(newResolved.id, 'resolved');
    await close(dismissed.id, 'dismissed');
    await db.update(feedbackItems).set({ updatedAt: '2001-01-01T00:00:00.000Z' }).where(eq(feedbackItems.id, oldResolved.id));
    await expect(service.purge({ statuses: ['open'] }, admin)).rejects.toMatchObject({ status: 422 });
    await expect(service.purge({ statuses: [] }, admin)).rejects.toMatchObject({ status: 422 });
    await expect(service.purge({ statuses: ['resolved'] }, actor)).rejects.toThrow('administrators');
    const aged = await service.purge({ statuses: ['resolved'], older_than: '2002-01-01T00:00:00Z' }, admin);
    expect(aged.ids.sort()).toEqual([oldResolved.id, dupOfOld.id].sort());
    expect(aged).toMatchObject({ deleted: 2, cascaded_duplicates: 1 });
    expect(await exists(newResolved.id)).toBe(true);
    // Keep the purge scoped to this test's rows: other closed fixtures may share the database.
    await db.update(feedbackItems).set({ updatedAt: '2001-06-01T00:00:00.000Z' }).where(inArray(feedbackItems.id, [newResolved.id, dismissed.id, stillOpen.id]));
    const rest = await service.purge({ statuses: ['resolved', 'dismissed'], older_than: '2001-12-31T00:00:00Z' }, admin);
    expect(rest.ids).not.toContain(stillOpen.id);
    expect(await exists(stillOpen.id)).toBe(true);
    const [audit] = await db.select().from(adminEvents).where(eq(adminEvents.type, 'feedback.purged')).orderBy(sql`id DESC`).limit(1);
    expect(rest.ids.sort()).toEqual([newResolved.id, dismissed.id].sort());
    expect(audit!.payload).toMatchObject({ statuses: ['resolved', 'dismissed'], older_than: '2001-12-31T00:00:00.000Z' });
  });

  it.each(['codex', 'claude', 'grok'] as const)('%s: MCP discovery/calls follow the switch in the same registry', async (engine) => {
    const registry = new McpToolsRegistry({ feedback: service } as unknown as ToolDeps);
    const host = { id: 700 } as Host;
    expect((await registry.listAvailable()).filter((t) => t.name.startsWith('feedback_'))).toHaveLength(5);
    const result = await registry.dispatch('feedback_submit', report(), host, 'host', engine);
    const data = JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
    ids.push(data.feedback.id);
    expect(data.feedback.source.engine).toBe(engine);
    await service.setEnabled(false);
    expect((await registry.listAvailable()).map((t) => t.name)).not.toContain('feedback_submit');
    const denied = await registry.dispatch('feedback_get', { id: data.feedback.id }, host, 'host', engine);
    expect(denied).toMatchObject({ isError: true });
    await service.setEnabled(true);
    expect((await registry.listAvailable()).map((t) => t.name)).toContain('feedback_get');
  });

  it('protects admin read/write endpoints with the existing capability matrix', async () => {
    const app = Fastify();
    const resolve = async (req: { headers: Record<string, unknown> }): Promise<AdminContext | null> => req.headers['x-role'] ? {
      user: { id: 1, active: 1, accessLevel: req.headers['x-role'] }, session: {},
    } as unknown as AdminContext : null;
    app.decorate('resolveAdmin', resolve);
    app.decorate('requireAdmin', async (req) => {
      const context = await resolve(req);
      if (!context) throw new UnauthorizedError();
      req.admin = context as never;
    });
    app.setErrorHandler((err, _req, reply) => reply.code((err as { status?: number }).status ?? 500).send({ message: err instanceof Error ? err.message : String(err) }));
    await app.register(fp(async () => {}, { name: 'auth-admin' }));
    await app.register(makeCapabilitiesPlugin({ service: null }));
    await registerAdminFeedbackRoutes(app, { db, env: loadTestEnv(), keyring: testKeyring() });
    try {
      expect((await app.inject({ url: '/admin/feedback/state' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/admin/feedback/state', headers: { 'x-role': 'viewer' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/admin/feedback/state', headers: { 'x-role': 'viewer' }, payload: { enabled: false } })).statusCode).toBe(403);
      const created = await app.inject({ method: 'POST', url: '/admin/feedback', headers: { 'x-role': 'fleet_operator' }, payload: report() });
      expect(created.statusCode).toBe(200);
      ids.push(created.json().feedback.id);
      const read = await app.inject({ url: `/admin/feedback/${ids.at(-1)}`, headers: { 'x-role': 'viewer' } });
      expect(read.json().feedback.report.description).toContain('wrapper error');
      const target = ids.at(-1)!;
      expect((await app.inject({ method: 'DELETE', url: `/admin/feedback/${target}`, headers: { 'x-role': 'viewer' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/admin/feedback/purge', headers: { 'x-role': 'viewer' }, payload: { statuses: ['resolved'] } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: `/admin/feedback/${target}`, headers: { 'x-role': 'fleet_operator' } })).statusCode).toBe(409);
      await close(target, 'dismissed');
      const removed = await app.inject({ method: 'DELETE', url: `/admin/feedback/${target}`, headers: { 'x-role': 'fleet_operator' } });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ deleted: 1, ids: [target] });
      const purged = await app.inject({ method: 'POST', url: '/admin/feedback/purge', headers: { 'x-role': 'fleet_operator' }, payload: { statuses: ['dismissed'], older_than: '2001-01-01T00:00:00Z' } });
      expect(purged.statusCode).toBe(200);
    } finally { await app.close(); }
  });
});

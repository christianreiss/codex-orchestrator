import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { eq, inArray } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb } from '../helpers/test-db.js';
import { testKeyring, loadTestEnv } from '../helpers/test-keyring.js';
import { FeedbackService } from '../../src/services/feedback.js';
import { FeedbackWorker } from '../../src/services/feedback/worker.js';
import { FeedbackPipelineStore } from '../../src/services/feedback/store.js';
import { FeedbackConfiguration } from '../../src/services/feedback/config.js';
import { FeedbackGithub, type GithubIssue } from '../../src/services/feedback/github.js';
import { encrypt } from '../../src/security/secret-box.js';
import { feedbackPipeline, feedbackEvents, feedbackItems, versions } from '../../src/db/schema.js';
import { SettingsService } from '../../src/services/settings.js';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import type { FeedbackVerdict } from '../../src/services/feedback/contract.js';

const handle = await getTestDb();
const older = 'a'.repeat(40), current = 'b'.repeat(40);
const actor = { host_id: 700, engine: 'codex' };
class GithubFixture extends FeedbackGithub {
  posts: Array<{ title: string; body: string; issue: number | null }> = [];
  issues: GithubIssue[] = [];
  lostResponse = false;
  offline = false;
  marker: { number: number; html_url: string } | null = null;
  override async head() { if (this.offline) throw new Error('fixture offline'); return current; }
  override async isBehind() { return true; }
  override async wrapperVersion() { return '0.9.31'; }
  override async search() { return this.issues; }
  override async context() { return this.issues.map((i) => ({ ...i, comments: [], fixes: [] })); }
  override async findMarker() { return this.marker; }
  override async publish(title: string, body: string, issue: number | null) {
    this.posts.push({ title, body, issue });
    this.marker = { number: issue ?? 42, html_url: `https://github.com/christianreiss/codex-orchestrator/issues/${issue ?? 42}` };
    if (this.lostResponse) throw new Error('lost ACK');
    return this.marker;
  }
}

describe.skipIf(!handle)('User feedback pipeline with real MySQL', () => {
  if (!handle) return;
  const db = handle!.db, keyring = testKeyring(), settings = new SettingsService(db);
  const service = new FeedbackService(db, keyring);
  const configuration = new FeedbackConfiguration(db, keyring);
  const app = Fastify();
  let saved: typeof versions.$inferSelect[];
  const keys = ['feedback_enabled', 'feedback_mode', 'feedback_user_settings', 'feedback_github_token', 'feedback_runner_lease', 'api_disabled'];
  let ids: string[] = [];
  let github: GithubFixture;
  let installed = current;
  let dirty = false;
  let passes = false;
  let verdict: FeedbackVerdict;
  let calls = 0;
  const worker = () => new FeedbackWorker({ db, keyring, env: loadTestEnv() }, app, {
    identity: () => ({ commit: installed, dirty }), github: () => github,
    probe: async () => ({ status: 200, json: { ok: passes } }),
    judge: async () => { calls++; return verdict; },
  });
  async function submit(type: 'bug' | 'feature' = 'bug', probe = true) {
    const response = await service.submit({ client_request_id: randomUUID(), type, title: 'API health result is incorrect',
      description: 'GET /healthz must return ok true', component: 'api',
      ...(probe ? { retest: { endpoint: 'health', pointer: '/ok', equals: true } } : {}) }, actor);
    ids.push(response.feedback.id);
    await db.update(feedbackPipeline).set({ createdCommit: installed }).where(eq(feedbackPipeline.feedbackId, response.feedback.id));
    return response.feedback.id;
  }
  const row = async (id: string) => (await db.select().from(feedbackPipeline).where(eq(feedbackPipeline.feedbackId, id)))[0]!;
  const due = async (id: string) => db.update(feedbackPipeline).set({ nextAttemptAt: new Date().toISOString() }).where(eq(feedbackPipeline.feedbackId, id));
  beforeAll(async () => {
    saved = await db.select().from(versions).where(inArray(versions.name, keys));
    const migration = await readFile(new URL('../../src/db/migrations/0086_feedback_github.sql', import.meta.url), 'utf8');
    for (let i = 0; i < 2; i++) for (const statement of splitSqlStatements(migration)) await db.execute(statement);
  });
  beforeEach(async () => {
    installed = current; dirty = false; passes = false; calls = 0;
    github = new GithubFixture('fixture');
    verdict = { verdict: 'new', reason: 'No matching issue found; API observation reproduces the symptom', issue_number: null,
      evidence_urls: [], public_title: 'API health result is incorrect', public_body: 'GET /healthz returns false instead of true.', comment: null };
    await settings.setFlag('feedback_enabled', true);
    await settings.setFlag('api_disabled', false);
    await settings.set('feedback_mode', 'user');
    await settings.set('feedback_user_settings', JSON.stringify({ revision: randomUUID(), auto_publish: true, runner_enabled: true, engine: 'codex', model: 'fixture' }));
    await settings.set('feedback_github_token', encrypt('test-only-token', keyring));
    await settings.set('feedback_runner_lease', '{}');
  });
  afterEach(async () => {
    if (ids.length) {
      await db.delete(feedbackPipeline).where(inArray(feedbackPipeline.feedbackId, ids));
      await db.delete(feedbackEvents).where(inArray(feedbackEvents.feedbackId, ids));
      await db.delete(feedbackItems).where(inArray(feedbackItems.id, ids));
    }
    ids = [];
  });
  afterAll(async () => {
    await db.delete(versions).where(inArray(versions.name, keys));
    if (saved.length) await db.insert(versions).values(saved);
    await app.close();
    await handle!.pool.end();
  });
  it('keeps developer submissions local without queueing a user pipeline', async () => {
    await settings.set('feedback_mode', 'source_developer');
    const id = await submit();
    expect(await row(id)).toBeUndefined();
    await worker().tick();
    expect(github.posts).toHaveLength(0);
  });
  it('holds an old version, then automatically retests the installed new build and publishes once', async () => {
    installed = older;
    const id = await submit(), runner = worker();
    await runner.tick();
    expect(await row(id)).toMatchObject({ versionState: 'old_version', reviewState: 'needs_retest', deliveryState: 'local' });
    expect(calls).toBe(0);
    installed = current;
    await runner.tick();
    expect(await row(id)).toMatchObject({ versionState: 'recent', reviewState: 'new', deliveryState: 'sent', githubIssueNumber: 42 });
    await runner.tick();
    expect(github.posts).toHaveLength(1);
    const detail = await service.get(id, actor);
    expect(detail.feedback.pipeline?.delivery_state).toBe('sent');
    expect(detail.events.map((e) => e.action)).toContain('publication_confirmed');
  });
  it('discards only when the original failing assertion now passes', async () => {
    installed = older;
    const id = await submit(), runner = worker();
    await runner.tick();
    installed = current; passes = true;
    await runner.tick();
    expect(await row(id)).toMatchObject({ reviewState: 'discarded', deliveryState: 'local' });
    expect((await service.get(id, actor)).feedback.status).toBe('dismissed');
    expect(github.posts).toHaveLength(0);
  });
  it('retains UI/host bugs without an executable assertion for manual retest', async () => {
    const id = await submit('bug', false);
    await worker().tick();
    expect(await row(id)).toMatchObject({ versionState: 'recent', reviewState: 'needs_retest', deliveryState: 'local' });
    expect(github.posts).toHaveLength(0);
  });
  it('publishes a current feature after checking for existing requests', async () => {
    const id = await submit('feature', false);
    await worker().tick();
    expect((await row(id)).deliveryState).toBe('sent');
  });
  it('links an existing issue and only comments when there is distinct current evidence', async () => {
    github.issues = [{ number: 9, html_url: 'https://github.com/christianreiss/codex-orchestrator/issues/9', title: 'Matching API bug', body: '', state: 'open' }];
    verdict = { ...verdict, verdict: 'known', issue_number: 9, evidence_urls: [github.issues[0]!.html_url] };
    const id = await submit();
    await worker().tick();
    expect(await row(id)).toMatchObject({ reviewState: 'known', githubIssueNumber: 9, deliveryState: 'local' });
    verdict.comment = 'Reproduced on the current build with the same API assertion.';
    await due(id); await worker().tick();
    expect(github.posts[0]?.issue).toBe(9);
  });
  it('reconciles a lost publication ACK without creating another issue', async () => {
    const id = await submit();
    github.lostResponse = true;
    await worker().tick();
    expect((await row(id)).deliveryState).toBe('uncertain');
    await due(id); await worker().tick();
    expect((await row(id)).deliveryState).toBe('sent');
    expect(github.posts).toHaveLength(1);
  });
  it('keeps an unresolved ambiguous outcome uncertain, even after explicit recheck', async () => {
    const id = await submit();
    github.lostResponse = true;
    await worker().tick(); github.marker = null;
    const item = (await service.get(id, actor)).feedback;
    await service.recheck({ id, expected_version: item.version }, actor);
    await worker().tick();
    expect(await row(id)).toMatchObject({ deliveryState: 'uncertain', nextAttemptAt: null });
    expect(github.posts).toHaveLength(1);
  });
  it('fences concurrent API workers and permits recovery after an expired lease', async () => {
    const first = await submit(), second = await submit();
    const a = new FeedbackPipelineStore(db), b = new FeedbackPipelineStore(db);
    const results = await Promise.all([a.take(), b.take()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const taken = results.find(Boolean)!;
    await db.update(feedbackPipeline).set({ leaseExpiresAt: '2000-01-01T00:00:00.000Z' }).where(eq(feedbackPipeline.feedbackId, taken.feedbackId));
    await settings.set('feedback_runner_lease', '{}');
    expect(await b.take()).not.toBeNull();
    expect([first, second]).toContain(taken.feedbackId);
    await expect(a.finish(taken, { reviewState: 'new' })).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each(['dirty', 'offline', 'no_opt_in', 'api_disabled', 'unclear', 'secret', 'fake_reference'])('does not publish when %s', async (kind) => {
    const id = await submit();
    if (kind === 'dirty') dirty = true;
    if (kind === 'offline') github.offline = true;
    if (kind === 'api_disabled') await settings.setFlag('api_disabled', true);
    if (kind === 'no_opt_in') {
      const c = await configuration.read();
      await configuration.save({ expected_revision: c.revision, config: { mode: 'user', auto_publish: false, runner_enabled: true, engine: 'codex', model: 'fixture' } }, 1);
    }
    if (kind === 'unclear') verdict.verdict = 'unclear';
    if (kind === 'secret') verdict.public_body = 'password=private123';
    if (kind === 'fake_reference') verdict.evidence_urls = ['https://github.com/christianreiss/codex-orchestrator/issues/999'];
    await worker().tick();
    expect(github.posts).toHaveLength(0);
    expect((await row(id)).deliveryState).not.toBe('sent');
  });
  it('uses configuration revisions and returns no stored token or ciphertext', async () => {
    const before = await configuration.read();
    expect(JSON.stringify(before)).not.toContain('test-only-token');
    expect(JSON.stringify(before)).not.toContain('sbox:');
    const next = await configuration.save({ expected_revision: before.revision, config: { mode: 'source_developer', auto_publish: false, runner_enabled: false, engine: null, model: null } }, 1);
    expect(next.revision).not.toBe(before.revision);
    await expect(configuration.save({ expected_revision: before.revision, config: { mode: 'user', auto_publish: true, runner_enabled: false, engine: null, model: null } }, 1)).rejects.toMatchObject({ code: 'conflict' });
  });
});

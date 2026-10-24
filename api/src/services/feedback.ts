import { AsyncLocalStorage } from 'node:async_hooks';
import { ownerRuntimeFor, mutateOwnerState, type OwnerMutationContext } from '../control-plane/state/runtime.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, asc, eq, inArray, lt, lte, like, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { adminEvents, feedbackItems, feedbackEvents, feedbackPipeline } from '../db/schema.js';
import { FeedbackConfiguration } from './feedback/config.js';
import { FeedbackPipelineStore, pipelineView } from './feedback/store.js';
import { buildIdentity } from './feedback/build-identity.js';
import { FeedbackGithub, sensitiveText } from './feedback/github.js';
import { searchTerms } from './feedback/worker.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import type { Keyring } from '../security/keyring.js';
import { encrypt, decrypt } from '../security/secret-box.js';
import { wsPublisher } from '../ws/publisher.js';
import { SettingsService } from './settings.js';
import {
  FEEDBACK_ENABLED_KEY, FEEDBACK_CLAIM_SECONDS, FEEDBACK_CLOSED_STATUSES, feedbackId, feedbackSubmitSchema,
  feedbackListSchema, feedbackClaimSchema, feedbackUpdateSchema, feedbackPurgeSchema, parseFeedback, type FeedbackActor,
} from './feedback-contract.js';

type Item = typeof feedbackItems.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const clearedClaim = { claimOwner: null, claimRequestKey: null, claimTokenHash: null, claimTokenEnc: null, claimExpiresAt: null };
const ownedFeedback = new AsyncLocalStorage<OwnerMutationContext>();
const system: FeedbackActor = { host_id: null, engine: null, kind: 'system' };
const scope = (actor: FeedbackActor) => `${actor.host_id ?? 'admin'}:${actor.engine ?? ''}:${actor.admin_user_id ?? ''}`;
const terminal = (status: string) => (FEEDBACK_CLOSED_STATUSES as readonly string[]).includes(status);

/** Token material never leaves claim responses; read APIs and events use this projection. */
export function feedbackView(row: Omit<Item, 'claimTokenEnc'>, full = true) {
  return {
    id: row.id, type: row.type, title: row.title, component: row.component,
    priority: row.priority, status: row.status, source: row.source,
    deployment: row.deployment, deployment_ref: row.deploymentRef,
    duplicate_of: row.duplicateOf, claim_owner: row.claimOwner,
    claim_expires_at: row.claimExpiresAt, version: row.version,
    created_at: row.createdAt, updated_at: row.updatedAt,
    ...(full ? { report: row.report, result: row.result } : {}),
  };
}

export class FeedbackService {
  private readonly settings: SettingsService;
  constructor(private readonly db: Database, private readonly keyring: Keyring) {
    this.settings = new SettingsService(db);
  }

  private async transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    const owner = ownerRuntimeFor(this.db);
    if (!owner) return this.db.transaction(run);
    let result: T;
    await mutateOwnerState(owner, { kind: 'feedback.mutation', payload: {}, prepare(context) {
      context.write(async tx => { result = await ownedFeedback.run(context, () => run(tx as unknown as Tx)); });
      return null;
    } });
    return result!;
  }
  async getEnabled(): Promise<boolean> { return this.settings.getFlag(FEEDBACK_ENABLED_KEY, false); }
  async setEnabled(enabled: boolean) {
    await this.settings.setFlag(FEEDBACK_ENABLED_KEY, enabled);
    wsPublisher.publish('feedback.changed', { enabled });
    return { enabled };
  }
  private async available(actor: FeedbackActor) {
    // Administrators retain access to history and can unblock claims while off.
    if (actor.admin_user_id === undefined && !await this.getEnabled()) {
      throw new ForbiddenError('Orchestrator feedback is disabled', 'feedback_disabled');
    }
  }
  private async row(tx: Tx, id: string): Promise<Item> {
    const context = ownedFeedback.getStore();
    let row = context ? context.draft.table('feedbackItems').get(id) as Item | undefined : (await tx.select().from(feedbackItems).where(eq(feedbackItems.id, id)).for('update'))[0];
    if (!row && context) {
      row = (await tx.select().from(feedbackItems).where(eq(feedbackItems.id, id)))[0];
      if (row) {
        if (!terminal(row.status)) throw new Error('Active feedback missing from owner projection');
        context.draft.upsert('feedbackItems', row);
        const pipeline = (await tx.select().from(feedbackPipeline).where(eq(feedbackPipeline.feedbackId, id)))[0];
        if (pipeline) context.draft.upsert('feedbackPipeline', pipeline);
      }
    }
    if (!row) throw new NotFoundError('Feedback not found');
    return row;
  }
  private async event(tx: Tx, row: Item, action: string, actor: FeedbackActor, detail: Record<string, unknown>) {
    const values = { id: randomUUID(), feedbackId: row.id, version: row.version, action, actor, detail, createdAt: row.updatedAt };
    const context = ownedFeedback.getStore();
    if (context) context.write(async ownedTx => { await ownedTx.insert(feedbackEvents).values(values); });
    else await tx.insert(feedbackEvents).values(values);
  }
  private async change(tx: Tx, row: Item, patch: Partial<Item>, action: string, actor: FeedbackActor, detail: Record<string, unknown>): Promise<Item> {
    const next = { ...row, ...patch, version: row.version + 1, updatedAt: new Date().toISOString() };
    const context = ownedFeedback.getStore();
    if (context) stageUpdate(context, 'feedbackItems', row.id, { ...patch, version: next.version, updatedAt: next.updatedAt });
    else await tx.update(feedbackItems).set({ ...patch, version: next.version, updatedAt: next.updatedAt }).where(eq(feedbackItems.id, row.id));
    await this.event(tx, next, action, actor, detail);
    return next;
  }
  private publish(id?: string) { wsPublisher.publish('feedback.changed', { id }); }

  async configuration() { return new FeedbackConfiguration(this.db, this.keyring).read(); }
  async saveConfiguration(input: unknown, adminUserId: number) { return new FeedbackConfiguration(this.db, this.keyring).save(input, adminUserId); }
  async recheck(input: unknown, actor: FeedbackActor) {
    await this.available(actor);
    const { id, expected_version } = parseFeedback(z.object({ id: z.string().uuid(), expected_version: z.number().int().positive() }).strict(), input);
    if ((await this.configuration()).mode !== 'user') throw new ValidationError('Select User feedback mode before requesting a GitHub check');
    return new FeedbackPipelineStore(this.db).recheck(id, expected_version, actor);
  }
  async preflight(input: unknown, actor: FeedbackActor) {
    await this.available(actor);
    const args = parseFeedback(z.object({ title: z.string().trim().min(3).max(255), component: z.string().trim().min(1).max(100).default('other') }).strict(), input);
    if (sensitiveText(args.title) || sensitiveText(args.component)) throw new ValidationError('Redact private data from title/component before searching GitHub');
    const configuration = new FeedbackConfiguration(this.db, this.keyring);
    const github = new FeedbackGithub(await configuration.token());
    const [head, results] = await Promise.all([github.head(), Promise.all(searchTerms(args).map((q) => github.search(q)))]);
    return { installed: buildIdentity(), upstream_commit: head, repository: 'christianreiss/codex-orchestrator',
      issues: [...new Map(results.flat().map((issue) => [issue.number, { number: issue.number, title: issue.title, state: issue.state, url: issue.html_url }])).values()] };
  }

  private async withPipeline<T extends { id: string }>(items: T[]) {
    if (!items.length) return items;
    const owner = ownerRuntimeFor(this.db);
    const rows = owner ? [...owner.state.snapshot().table('feedbackPipeline').all()].filter(row => items.some(item => item.id === row.feedbackId)) : await this.db.select().from(feedbackPipeline).where(inArray(feedbackPipeline.feedbackId, items.map((i) => i.id)));
    if (owner) { const cold = items.filter(item => !owner.state.snapshot().table('feedbackItems').has(item.id)); if (cold.length) rows.push(...await this.db.select().from(feedbackPipeline).where(inArray(feedbackPipeline.feedbackId, cold.map(item => item.id)))); }
    const lookup = new Map(rows.map((r) => [r.feedbackId, r]));
    return items.map((item) => ({ ...item, ...(lookup.has(item.id) ? { pipeline: pipelineView(lookup.get(item.id)!) } : {}) }));
  }

  async expireClaims(id?: string): Promise<void> { return this.expire(id); }

  private async expire(id?: string): Promise<void> {
    const owner = ownerRuntimeFor(this.db);
    if (owner && !owner.state.snapshot().table('feedbackItems').all().some(row => row.status === 'in_progress' && row.claimExpiresAt && row.claimExpiresAt <= new Date().toISOString() && (!id || row.id === id))) return;
    const expired = await this.transaction(async (tx) => {
      const now = new Date().toISOString();
      const context = ownedFeedback.getStore();
      const rows = context ? context.draft.table('feedbackItems').all().filter(row => row.status === 'in_progress' && row.claimExpiresAt && row.claimExpiresAt <= now && (!id || row.id === id)) as Item[] : await tx.select().from(feedbackItems).where(and(
        eq(feedbackItems.status, 'in_progress'), lte(feedbackItems.claimExpiresAt, now),
        id ? eq(feedbackItems.id, id) : undefined,
      )).orderBy(asc(feedbackItems.id)).for('update');
      for (const row of rows) await this.change(tx, row, { ...clearedClaim, status: 'open' }, 'claim_expired', system, {});
      return rows.length;
    });
    if (expired) this.publish(id);
  }

  async submit(input: unknown, actor: FeedbackActor) {
    await this.available(actor);
    const data = parseFeedback(feedbackSubmitSchema, input);
    const userMode = (await this.configuration()).mode === 'user';
    const { client_request_id, agent_uuid, ...report } = data;
    const requestKey = hash(`${scope(actor)}:${client_request_id.toLowerCase()}`);
    const requestDigest = hash(JSON.stringify({ ...report, agent_uuid: agent_uuid ?? null }));
    const id = randomUUID();
    const result = await this.transaction(async (tx) => {
      const now = new Date().toISOString();
      const context = ownedFeedback.getStore();
      if (context) {
        const previous = context.draft.table('feedbackItems').all().find(row => row.requestKey === requestKey) ?? (await tx.select().from(feedbackItems).where(eq(feedbackItems.requestKey, requestKey)))[0];
        if (previous) {
          if (previous.requestDigest !== requestDigest) throw new ConflictError('Request ID already used for different feedback');
          return { feedback: feedbackView(previous), replayed: true };
        }
        const row: Item = { id, requestKey, requestDigest, type: report.type, title: report.title, component: report.component, priority: report.priority,
          report, source: { ...actor, ...(agent_uuid ? { agent_uuid } : {}) }, status: 'open', result: null, deployment: 'unknown', deploymentRef: null, duplicateOf: null,
          ...clearedClaim, version: 1, createdAt: now, updatedAt: now };
        context.draft.upsert('feedbackItems', row);
        context.write(async ownedTx => { await ownedTx.insert(feedbackItems).values(row); });
        await this.event(tx, row, 'submitted', actor, { report });
        if (userMode) {
          const pipeline: typeof feedbackPipeline.$inferSelect = { feedbackId: id, createdCommit: buildIdentity().commit, versionState: 'unknown', reviewState: 'pending', deliveryState: 'local', testedCommit: null, upstreamCommit: null,
            evidence: data.retest ? { probe: data.retest } : {}, githubIssueNumber: null, githubUrl: null, reason: null, leaseToken: null, leaseExpiresAt: null, nextAttemptAt: now, attempts: 0, updatedAt: now };
          context.draft.upsert('feedbackPipeline', pipeline);
          context.write(async ownedTx => { await ownedTx.insert(feedbackPipeline).values(pipeline); });
        }
        return { feedback: feedbackView(row), replayed: false };
      }
      await tx.insert(feedbackItems).values({
        id, requestKey, requestDigest, type: report.type, title: report.title,
        component: report.component, priority: report.priority, report,
        source: { ...actor, ...(agent_uuid ? { agent_uuid } : {}) }, createdAt: now, updatedAt: now,
      }).onDuplicateKeyUpdate({ set: { id: sql`id` } });
      const [row] = await tx.select().from(feedbackItems).where(eq(feedbackItems.requestKey, requestKey)).for('update');
      if (!row || row.requestDigest !== requestDigest) throw new ConflictError('Request ID already used for different feedback');
      if (row.id === id) {
        await this.event(tx, row, 'submitted', actor, { report });
        if (userMode) await tx.insert(feedbackPipeline).values({ feedbackId: id, createdCommit: buildIdentity().commit,
          evidence: data.retest ? { probe: data.retest } : {}, nextAttemptAt: now, updatedAt: now });
      }
      return { feedback: feedbackView(row), replayed: row.id !== id };
    });
    if (!result.replayed) this.publish(result.feedback.id);
    return { ...result, feedback: (await this.withPipeline([result.feedback]))[0]! };
  }

  /**
   * Counts for the console's top-bar indicator: `open` is unhandled (nobody has
   * claimed it), `blocked` waits for a decision. Expired claims are released
   * first, so a report an agent abandoned counts as open again.
   */
  async summary(actor: FeedbackActor) {
    await this.available(actor);
    await this.expire();
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      const rows = owner.state.snapshot().table('feedbackItems').all();
      return { open: rows.filter(row => row.status === 'open').length, in_progress: rows.filter(row => row.status === 'in_progress').length, blocked: rows.filter(row => row.status === 'blocked').length };
    }
    const rows = await this.db
      .select({ status: feedbackItems.status, count: sql<number>`count(*)` })
      .from(feedbackItems)
      .where(inArray(feedbackItems.status, ['open', 'in_progress', 'blocked']))
      .groupBy(feedbackItems.status);
    const count = (status: string) => Number(rows.find((row) => row.status === status)?.count ?? 0);
    return { open: count('open'), in_progress: count('in_progress'), blocked: count('blocked') };
  }

  async list(input: unknown, actor: FeedbackActor) {
    await this.available(actor);
    const args = parseFeedback(feedbackListSchema, input);
    await this.expire();
    const owner = ownerRuntimeFor(this.db);
    if (owner && args.status && !terminal(args.status)) {
      const snapshot = owner.state.snapshot(), priority = ['critical', 'high', 'normal', 'low'];
      const rows = snapshot.table('feedbackItems').all().filter(row => {
        const pipeline = snapshot.table('feedbackPipeline').get(row.id);
        return (!args.status || row.status === args.status) && (!args.type || row.type === args.type) && (!args.component || row.component === args.component) && (!args.priority || row.priority === args.priority)
          && (!args.version_state || pipeline?.versionState === args.version_state) && (!args.review_state || pipeline?.reviewState === args.review_state) && (!args.delivery_state || pipeline?.deliveryState === args.delivery_state)
          && (!args.query || row.title.toLowerCase().includes(args.query.toLowerCase()) || String(row.report.description ?? '').toLowerCase().includes(args.query.toLowerCase()));
      }).sort((a,b) => priority.indexOf(a.priority) - priority.indexOf(b.priority) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(args.offset, args.offset + args.limit + 1);
      return { feedback: await this.withPipeline(rows.slice(0, args.limit).map(row => feedbackView(row, false))), next_offset: rows.length > args.limit ? args.offset + args.limit : null };
    }
    const where = and(
      args.version_state || args.review_state || args.delivery_state ? inArray(feedbackItems.id,
        this.db.select({ id: feedbackPipeline.feedbackId }).from(feedbackPipeline).where(and(
          args.version_state ? eq(feedbackPipeline.versionState, args.version_state) : undefined,
          args.review_state ? eq(feedbackPipeline.reviewState, args.review_state) : undefined,
          args.delivery_state ? eq(feedbackPipeline.deliveryState, args.delivery_state) : undefined,
        ))) : undefined,
      args.status ? eq(feedbackItems.status, args.status) : undefined,
      args.type ? eq(feedbackItems.type, args.type) : undefined,
      args.component ? eq(feedbackItems.component, args.component) : undefined,
      args.priority ? eq(feedbackItems.priority, args.priority) : undefined,
      args.query ? or(like(feedbackItems.title, `%${args.query.replace(/[\\%_]/g, '\\$&')}%`),
        like(sql`JSON_UNQUOTE(JSON_EXTRACT(${feedbackItems.report}, '$.description'))`, `%${args.query.replace(/[\\%_]/g, '\\$&')}%`)) : undefined,
    );
    const rows = await this.db.select().from(feedbackItems).where(where)
      .orderBy(sql`FIELD(${feedbackItems.priority}, 'critical', 'high', 'normal', 'low')`, asc(feedbackItems.createdAt), asc(feedbackItems.id))
      .limit(args.limit + 1).offset(args.offset);
    return { feedback: await this.withPipeline(rows.slice(0, args.limit).map((r) => feedbackView(r, false))),
      next_offset: rows.length > args.limit ? args.offset + args.limit : null };
  }

  async get(input: unknown, actor: FeedbackActor) {
    await this.available(actor);
    const id = feedbackId(input);
    await this.expire(id);
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      const snapshot = owner.state.snapshot(), row = snapshot.table('feedbackItems').get(id) ?? (await this.db.select().from(feedbackItems).where(eq(feedbackItems.id, id)))[0];
      if (!row) throw new NotFoundError('Feedback not found');
      const pipeline = snapshot.table('feedbackPipeline').get(id) ?? (!snapshot.table('feedbackItems').has(id) ? (await this.db.select().from(feedbackPipeline).where(eq(feedbackPipeline.feedbackId, id)))[0] : undefined);
      // Only requested cold history is read. Bound it to the already captured
      // owned version so concurrent later events cannot produce a torn response.
      const events = await this.db.select().from(feedbackEvents).where(and(eq(feedbackEvents.feedbackId, id), lte(feedbackEvents.version, row.version))).orderBy(asc(feedbackEvents.version));
      return { feedback: { ...feedbackView(row), ...(pipeline ? { pipeline: pipelineView(pipeline) } : {}) }, events: events.map(event => ({ id: event.id, version: event.version, action: event.action, actor: event.actor, detail: event.detail, created_at: event.createdAt })) };
    }
    // Same transaction gives a consistent item/version and its event history.
    return this.transaction(async (tx) => {
      const row = await this.row(tx, id);
      const events = await tx.select().from(feedbackEvents).where(eq(feedbackEvents.feedbackId, id)).orderBy(asc(feedbackEvents.version));
      const [pipeline] = await tx.select().from(feedbackPipeline).where(eq(feedbackPipeline.feedbackId, id));
      return { feedback: { ...feedbackView(row), ...(pipeline ? { pipeline: pipelineView(pipeline) } : {}) }, events: events.map((e) => ({
        id: e.id, version: e.version, action: e.action, actor: e.actor, detail: e.detail, created_at: e.createdAt,
      })) };
    });
  }

  private owns(row: Item, actor: FeedbackActor, token?: string): boolean {
    return Boolean(token && row.claimTokenHash && hash(token) === row.claimTokenHash &&
      row.claimOwner && scope(row.claimOwner as FeedbackActor) === scope(actor) &&
      row.claimExpiresAt && row.claimExpiresAt > new Date().toISOString());
  }

  async claim(input: unknown, actor: FeedbackActor) {
    await this.available(actor);
    const args = parseFeedback(feedbackClaimSchema, input);
    if (args.action === 'acquire' && !args.client_request_id) throw new ValidationError('client_request_id required for acquire');
    if (args.action === 'force_release' && (actor.admin_user_id === undefined || !args.reason)) throw new ForbiddenError('Administrative force release requires a reason');
    await this.expire(args.id);
    const result = await this.transaction(async (tx) => {
      const row = await this.row(tx, args.id);
      const requestKey = hash(`${scope(actor)}:${args.client_request_id?.toLowerCase() ?? ''}`);
      if (args.action === 'acquire') {
        if (row.status === 'in_progress') {
          if (row.claimRequestKey === requestKey && row.claimOwner && scope(row.claimOwner as FeedbackActor) === scope(actor)) {
            const encrypted = row.claimTokenEnc ?? (ownedFeedback.getStore() ? (await tx.select({ token: feedbackItems.claimTokenEnc }).from(feedbackItems).where(eq(feedbackItems.id, row.id)))[0]?.token : null);
            if (!encrypted) throw new ConflictError('Feedback claim response unavailable');
            return { feedback: feedbackView(row), claim_token: decrypt(encrypted, this.keyring), replayed: true };
          }
          throw new ConflictError('Feedback already claimed', 'feedback_claimed');
        }
        if (terminal(row.status)) throw new ConflictError('Reopen feedback before claiming it');
        const token = randomUUID();
        const next = await this.change(tx, row, {
          status: 'in_progress', claimOwner: { ...actor, ...(args.agent_uuid ? { agent_uuid: args.agent_uuid } : {}) },
          claimRequestKey: requestKey, claimTokenHash: hash(token), claimTokenEnc: encrypt(token, this.keyring),
          claimExpiresAt: new Date(Date.now() + FEEDBACK_CLAIM_SECONDS * 1000).toISOString(),
        }, 'claimed', actor, {});
        return { feedback: feedbackView(next), claim_token: token, replayed: false };
      }
      if (args.action !== 'force_release' && !this.owns(row, actor, args.claim_token)) throw new ConflictError('Live claim token required', 'feedback_claim_lost');
      if (args.action === 'renew') {
        const next = await this.change(tx, row, { claimExpiresAt: new Date(Date.now() + FEEDBACK_CLAIM_SECONDS * 1000).toISOString() }, 'claim_renewed', actor, {});
        return { feedback: feedbackView(next), claim_token: args.claim_token, replayed: false };
      }
      if (row.status !== 'in_progress') throw new ConflictError('No active claim to release');
      const next = await this.change(tx, row, { ...clearedClaim, status: 'open' }, args.action === 'force_release' ? 'claim_force_released' : 'claim_released', actor, { reason: args.reason ?? null });
      return { feedback: feedbackView(next), replayed: false };
    });
    if (!result.replayed) this.publish(args.id);
    return result;
  }

  async update(input: unknown, actor: FeedbackActor) {
    await this.available(actor);
    const args = parseFeedback(feedbackUpdateSchema, input);
    const { id, expected_version, claim_token, ...detail } = args;
    if (!Object.keys(detail).length) throw new ValidationError('An update or note is required');
    await this.expire(id);
    const result = await this.transaction(async (tx) => {
      const row = await this.row(tx, id);
      if (row.version !== expected_version) throw new ConflictError('Feedback changed; read current version before updating', 'feedback_version_conflict');
      const admin = actor.admin_user_id !== undefined;
      const onlyNote = Object.keys(detail).every((k) => k === 'note');
      if (!admin && !onlyNote && (row.status === 'in_progress' || args.status && args.status !== 'open') && !this.owns(row, actor, claim_token)) {
        throw new ConflictError('Live claim token required', 'feedback_claim_lost');
      }
      if (claim_token && !this.owns(row, actor, claim_token)) throw new ConflictError('Claim expired or replaced', 'feedback_claim_lost');
      if (args.status === 'resolved' && (!args.resolution || !args.fix_ref || !args.verification)) throw new ValidationError('resolved requires resolution, fix_ref and verification');
      if (args.status && ['blocked', 'dismissed'].includes(args.status) && !args.reason) throw new ValidationError(`${args.status} requires reason`);
      if (args.status === 'duplicate') {
        if (!args.duplicate_of || args.duplicate_of === id) throw new ValidationError('duplicate requires another feedback ID');
        const context = ownedFeedback.getStore();
        const target = context ? context.draft.table('feedbackItems').get(args.duplicate_of) ?? (await tx.select({ id: feedbackItems.id, status: feedbackItems.status }).from(feedbackItems).where(eq(feedbackItems.id, args.duplicate_of)))[0] : (await tx.select({ id: feedbackItems.id, status: feedbackItems.status }).from(feedbackItems).where(eq(feedbackItems.id, args.duplicate_of)).for('update'))[0];
        if (!target || target.status === 'duplicate') throw new ValidationError('duplicate_of must refer to an existing canonical feedback item');
        const references = context ? context.draft.table('feedbackItems').all().filter(item => item.duplicateOf === id).slice(0, 1) : await tx.select({ id: feedbackItems.id }).from(feedbackItems).where(eq(feedbackItems.duplicateOf, id)).limit(1);
        if (references.length) throw new ValidationError('A canonical item referenced by duplicates cannot itself become a duplicate');
      } else if (args.duplicate_of) throw new ValidationError('duplicate_of requires status duplicate');
      const patch: Partial<Item> = {};
      for (const k of ['type', 'title', 'component', 'priority', 'status', 'deployment'] as const) if (args[k] !== undefined) patch[k] = args[k];
      if (args.deployment_ref !== undefined) patch.deploymentRef = args.deployment_ref;
      if (args.deployment === 'deployed' && !(args.deployment_ref ?? row.deploymentRef)) throw new ValidationError('deployed requires deployment_ref');
      if (args.status === 'open' && row.status !== 'open') {
        patch.result = null; patch.duplicateOf = null; patch.deployment = 'unknown'; patch.deploymentRef = null;
      }
      if (args.status && args.status !== 'open') {
        patch.result = { resolution: args.resolution ?? null, fix_ref: args.fix_ref ?? null, verification: args.verification ?? null, reason: args.reason ?? null };
        patch.duplicateOf = args.status === 'duplicate' ? args.duplicate_of! : null;
        if (args.status === 'resolved' && args.deployment === undefined && row.deployment === 'unknown') patch.deployment = 'not_deployed';
      } else if (args.resolution || args.fix_ref || args.verification || args.reason) throw new ValidationError('Outcome fields require a closing or blocked status');
      if (args.status) Object.assign(patch, clearedClaim);
      const next = await this.change(tx, row, patch, 'updated', actor, detail);
      return { feedback: feedbackView(next) };
    });
    this.publish(id);
    return result;
  }

  /**
   * Hard-deletes closed items with their history. Duplicates pointing at a deleted
   * item are deleted with it: they are always closed, and keeping them with a null
   * duplicate_of would break the duplicate invariant. Items, events and the audit
   * row commit together.
   */
  private async purgeRows(tx: Tx, rows: Item[], auditType: string, actor: FeedbackActor, criteria: Record<string, unknown>) {
    const seed = rows.map((r) => r.id);
    const context = ownedFeedback.getStore();
    const duplicates = seed.length ? await tx.select().from(feedbackItems)
      .where(inArray(feedbackItems.duplicateOf, seed)).orderBy(asc(feedbackItems.id)).for('update') : [];
    const all = [...rows, ...duplicates.filter((d) => !seed.includes(d.id))];
    const ids = all.map((r) => r.id);
    let events = 0;
    if (ids.length) {
      const eventResult = await tx.delete(feedbackEvents).where(inArray(feedbackEvents.feedbackId, ids));
      events = Number(eventResult[0]?.affectedRows ?? 0);
      await tx.delete(feedbackItems).where(inArray(feedbackItems.id, ids));
      if (context) for (const id of ids) { context.draft.remove('feedbackItems', id); context.draft.remove('feedbackPipeline', id); }
    }
    const byStatus: Record<string, number> = {};
    for (const row of all) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    const summary = { deleted: ids.length, events, cascaded_duplicates: all.length - rows.length, by_status: byStatus };
    await tx.insert(adminEvents).values({ type: auditType, hostId: null, createdAt: new Date().toISOString(), payload: {
      ...summary, ...criteria, admin_user_id: actor.admin_user_id ?? null,
      items: all.map((r) => ({ id: r.id, title: r.title, status: r.status, duplicate_of: r.duplicateOf })),
    } });
    return { ...summary, ids };
  }

  async remove(input: unknown, actor: FeedbackActor) {
    if (actor.admin_user_id === undefined) throw new ForbiddenError('Only administrators can delete feedback');
    const id = feedbackId(input);
    const result = await this.transaction(async (tx) => {
      const row = await this.row(tx, id);
      // Closed items never hold a claim (every status change clears it), so this also refuses live claims.
      if (!terminal(row.status) || (row.claimExpiresAt && row.claimExpiresAt > new Date().toISOString())) {
        throw new ConflictError('Only resolved, dismissed or duplicate feedback without a live claim can be deleted', 'feedback_not_closed');
      }
      return this.purgeRows(tx, [row], 'feedback.deleted', actor, { id });
    });
    this.publish(id);
    return result;
  }

  async purge(input: unknown, actor: FeedbackActor) {
    if (actor.admin_user_id === undefined) throw new ForbiddenError('Only administrators can purge feedback');
    const args = parseFeedback(feedbackPurgeSchema, input);
    const statuses = [...new Set(args.statuses)];
    const result = await this.transaction(async (tx) => {
      const rows = await tx.select().from(feedbackItems).where(and(
        inArray(feedbackItems.status, statuses),
        args.older_than ? lt(feedbackItems.updatedAt, args.older_than) : undefined,
      )).orderBy(asc(feedbackItems.id)).for('update');
      return this.purgeRows(tx, rows, 'feedback.purged', actor, { statuses, older_than: args.older_than ?? null });
    });
    if (result.deleted) this.publish();
    return result;
  }
}

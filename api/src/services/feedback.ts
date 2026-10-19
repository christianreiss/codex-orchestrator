import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lt, lte, like, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { adminEvents, feedbackItems, feedbackEvents } from '../db/schema.js';
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
const system: FeedbackActor = { host_id: null, engine: null, kind: 'system' };
const scope = (actor: FeedbackActor) => `${actor.host_id ?? 'admin'}:${actor.engine ?? ''}:${actor.admin_user_id ?? ''}`;
const terminal = (status: string) => (FEEDBACK_CLOSED_STATUSES as readonly string[]).includes(status);

/** Token material never leaves claim responses; read APIs and events use this projection. */
export function feedbackView(row: Item, full = true) {
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
    const [row] = await tx.select().from(feedbackItems).where(eq(feedbackItems.id, id)).for('update');
    if (!row) throw new NotFoundError('Feedback not found');
    return row;
  }
  private async event(tx: Tx, row: Item, action: string, actor: FeedbackActor, detail: Record<string, unknown>) {
    await tx.insert(feedbackEvents).values({ id: randomUUID(), feedbackId: row.id, version: row.version, action, actor, detail, createdAt: row.updatedAt });
  }
  private async change(tx: Tx, row: Item, patch: Partial<Item>, action: string, actor: FeedbackActor, detail: Record<string, unknown>): Promise<Item> {
    const next = { ...row, ...patch, version: row.version + 1, updatedAt: new Date().toISOString() };
    await tx.update(feedbackItems).set({ ...patch, version: next.version, updatedAt: next.updatedAt }).where(eq(feedbackItems.id, row.id));
    await this.event(tx, next, action, actor, detail);
    return next;
  }
  private publish(id?: string) { wsPublisher.publish('feedback.changed', { id }); }

  private async expire(id?: string): Promise<void> {
    const expired = await this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const rows = await tx.select().from(feedbackItems).where(and(
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
    const { client_request_id, agent_uuid, ...report } = data;
    const requestKey = hash(`${scope(actor)}:${client_request_id.toLowerCase()}`);
    const requestDigest = hash(JSON.stringify({ ...report, agent_uuid: agent_uuid ?? null }));
    const id = randomUUID();
    const result = await this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      await tx.insert(feedbackItems).values({
        id, requestKey, requestDigest, type: report.type, title: report.title,
        component: report.component, priority: report.priority, report,
        source: { ...actor, ...(agent_uuid ? { agent_uuid } : {}) }, createdAt: now, updatedAt: now,
      }).onDuplicateKeyUpdate({ set: { id: sql`id` } });
      const [row] = await tx.select().from(feedbackItems).where(eq(feedbackItems.requestKey, requestKey)).for('update');
      if (!row || row.requestDigest !== requestDigest) throw new ConflictError('Request ID already used for different feedback');
      if (row.id === id) await this.event(tx, row, 'submitted', actor, { report });
      return { feedback: feedbackView(row), replayed: row.id !== id };
    });
    if (!result.replayed) this.publish(result.feedback.id);
    return result;
  }

  /**
   * Counts for the console's top-bar indicator: `open` is unhandled (nobody has
   * claimed it), `blocked` waits for a decision. Expired claims are released
   * first, so a report an agent abandoned counts as open again.
   */
  async summary(actor: FeedbackActor) {
    await this.available(actor);
    await this.expire();
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
    const where = and(
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
    return { feedback: rows.slice(0, args.limit).map((r) => feedbackView(r, false)),
      next_offset: rows.length > args.limit ? args.offset + args.limit : null };
  }

  async get(input: unknown, actor: FeedbackActor) {
    await this.available(actor);
    const id = feedbackId(input);
    await this.expire(id);
    // Same transaction gives a consistent item/version and its event history.
    return this.db.transaction(async (tx) => {
      const row = await this.row(tx, id);
      const events = await tx.select().from(feedbackEvents).where(eq(feedbackEvents.feedbackId, id)).orderBy(asc(feedbackEvents.version));
      return { feedback: feedbackView(row), events: events.map((e) => ({
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
    const result = await this.db.transaction(async (tx) => {
      const row = await this.row(tx, args.id);
      const requestKey = hash(`${scope(actor)}:${args.client_request_id?.toLowerCase() ?? ''}`);
      if (args.action === 'acquire') {
        if (row.status === 'in_progress') {
          if (row.claimRequestKey === requestKey && row.claimTokenEnc && row.claimOwner && scope(row.claimOwner as FeedbackActor) === scope(actor)) {
            return { feedback: feedbackView(row), claim_token: decrypt(row.claimTokenEnc, this.keyring), replayed: true };
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
    const result = await this.db.transaction(async (tx) => {
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
        const [target] = await tx.select({ id: feedbackItems.id, status: feedbackItems.status }).from(feedbackItems).where(eq(feedbackItems.id, args.duplicate_of)).for('update');
        if (!target || target.status === 'duplicate') throw new ValidationError('duplicate_of must refer to an existing canonical feedback item');
        const references = await tx.select({ id: feedbackItems.id }).from(feedbackItems).where(eq(feedbackItems.duplicateOf, id)).limit(1);
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
    const duplicates = seed.length ? await tx.select().from(feedbackItems)
      .where(inArray(feedbackItems.duplicateOf, seed)).orderBy(asc(feedbackItems.id)).for('update') : [];
    const all = [...rows, ...duplicates.filter((d) => !seed.includes(d.id))];
    const ids = all.map((r) => r.id);
    let events = 0;
    if (ids.length) {
      const eventResult = await tx.delete(feedbackEvents).where(inArray(feedbackEvents.feedbackId, ids));
      events = Number(eventResult[0]?.affectedRows ?? 0);
      await tx.delete(feedbackItems).where(inArray(feedbackItems.id, ids));
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
    const result = await this.db.transaction(async (tx) => {
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
    const result = await this.db.transaction(async (tx) => {
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

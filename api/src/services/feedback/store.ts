import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { feedbackItems, feedbackEvents, feedbackPipeline, versions } from '../../db/schema.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';
import { wsPublisher } from '../../ws/publisher.js';
import { buildIdentity } from './build-identity.js';
import { reportDigest } from './config.js';
import type { FeedbackActor } from '../feedback-contract.js';

export type PipelineRow = typeof feedbackPipeline.$inferSelect;
export type ReportRow = typeof feedbackItems.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export function pipelineView(row: PipelineRow) {
  return { version_state: row.versionState, review_state: row.reviewState, delivery_state: row.deliveryState,
    created_commit: row.createdCommit, tested_commit: row.testedCommit, upstream_commit: row.upstreamCommit,
    github_issue_number: row.githubIssueNumber, github_url: row.githubUrl, reason: row.reason,
    checked_at: row.evidence.checked_at ?? null, evidence_urls: row.evidence.verdict?.evidence_urls ?? [],
    probe: row.evidence.probe ?? null, baseline: row.evidence.baseline ?? null, retest: row.evidence.retest ?? null,
    next_attempt_at: row.nextAttemptAt, updated_at: row.updatedAt };
}
export const digestReport = (row: ReportRow) => reportDigest({ title: row.title, type: row.type, component: row.component, report: row.report });

export class FeedbackPipelineStore {
  constructor(readonly db: Database) {}
  async update(tx: Tx, row: PipelineRow, patch: Partial<PipelineRow>, action: string, actor: Record<string, unknown> = { kind: 'system' }) {
    const [item] = await tx.select().from(feedbackItems).where(eq(feedbackItems.id, row.feedbackId)).for('update');
    if (!item) throw new NotFoundError('Feedback not found');
    const now = new Date().toISOString();
    await tx.update(feedbackPipeline).set({ ...patch, updatedAt: now }).where(eq(feedbackPipeline.feedbackId, row.feedbackId));
    await tx.update(feedbackItems).set({ version: item.version + 1, updatedAt: now,
      ...(patch.reviewState === 'discarded' && item.status === 'open' ? { status: 'dismissed', result: { reason: patch.reason } } : {}),
    }).where(eq(feedbackItems.id, row.feedbackId));
    await tx.insert(feedbackEvents).values({ id: randomUUID(), feedbackId: row.feedbackId, version: item.version + 1,
      action, actor, detail: { version_state: patch.versionState ?? row.versionState,
        review_state: patch.reviewState ?? row.reviewState, delivery_state: patch.deliveryState ?? row.deliveryState,
        reason: patch.reason ?? row.reason, github_url: patch.githubUrl ?? row.githubUrl }, createdAt: now });
  }
  async recheck(id: string, expectedVersion: number, actor: FeedbackActor) {
    await this.db.transaction(async (tx) => {
      const [item] = await tx.select().from(feedbackItems).where(eq(feedbackItems.id, id)).for('update');
      if (!item) throw new NotFoundError('Feedback not found');
      if (item.version !== expectedVersion) throw new ConflictError('Feedback changed; reload before requesting a check');
      const [pipeline] = await tx.select().from(feedbackPipeline).where(eq(feedbackPipeline.feedbackId, id)).for('update');
      if (pipeline?.deliveryState === 'sent') throw new ConflictError('This report has already been published');
      if (pipeline?.leaseExpiresAt && pipeline.leaseExpiresAt > new Date().toISOString()) throw new ConflictError('Feedback check is already running');
      if (!pipeline) {
        await tx.insert(feedbackPipeline).values({ feedbackId: id, createdCommit: buildIdentity().commit,
          evidence: { ...(item.report.retest ? { probe: item.report.retest as PipelineRow['evidence']['probe'] } : {}) },
          nextAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      } else await this.update(tx, pipeline, { nextAttemptAt: new Date().toISOString(), attempts: 0,
        // Uncertain publications stay uncertain until their marker is found.
        reviewState: 'pending', reason: 'Recheck requested', leaseToken: null, leaseExpiresAt: null }, 'recheck_requested', actor);
    });
    wsPublisher.publish('feedback.changed', { id });
    return { queued: true, id };
  }
  async take(): Promise<PipelineRow | null> {
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      // One server-side review at a time across all API processes.
      await tx.insert(versions).values({ name: 'feedback_runner_lease', version: '{}', updatedAt: now })
        .onDuplicateKeyUpdate({ set: { name: 'feedback_runner_lease' } });
      const [lock] = await tx.select().from(versions).where(eq(versions.name, 'feedback_runner_lease')).for('update');
      const lease = JSON.parse(lock!.version ?? '{}') as { until?: string };
      if (lease.until && lease.until > now) return null;
      const [row] = await tx.select().from(feedbackPipeline).where(and(
        lte(feedbackPipeline.nextAttemptAt, now),
        or(isNull(feedbackPipeline.leaseExpiresAt), lte(feedbackPipeline.leaseExpiresAt, now)),
      )).orderBy(asc(feedbackPipeline.nextAttemptAt)).limit(1).for('update');
      if (!row) return null;
      const token = randomUUID();
      const until = new Date(Date.now() + 330_000).toISOString();
      await tx.update(versions).set({ version: JSON.stringify({ token, until }) }).where(eq(versions.name, 'feedback_runner_lease'));
      await tx.update(feedbackPipeline).set({ leaseToken: token, leaseExpiresAt: until, attempts: row.attempts + 1 })
        .where(eq(feedbackPipeline.feedbackId, row.feedbackId));
      return { ...row, leaseToken: token, leaseExpiresAt: until, attempts: row.attempts + 1 };
    });
  }
  async finish(row: PipelineRow, patch: Partial<PipelineRow>, action = 'feedback_checked') {
    await this.db.transaction(async (tx) => {
      // Keep item -> pipeline lock ordering consistent with admin mutations.
      const [item] = await tx.select().from(feedbackItems).where(eq(feedbackItems.id, row.feedbackId)).for('update');
      if (patch.evidence?.report_digest && item && digestReport(item) !== patch.evidence.report_digest)
        throw new ConflictError('Report changed during feedback check');
      const [current] = await tx.select().from(feedbackPipeline).where(eq(feedbackPipeline.feedbackId, row.feedbackId)).for('update');
      if (!current || current.leaseToken !== row.leaseToken || !current.leaseExpiresAt || current.leaseExpiresAt <= new Date().toISOString())
        throw new ConflictError('Feedback worker lease lost');
      await this.update(tx, current, patch, action);
    });
    wsPublisher.publish('feedback.changed', { id: row.feedbackId });
  }
  async release(row: PipelineRow) {
    await this.db.transaction(async (tx) => {
      await tx.update(feedbackPipeline).set({ leaseToken: null, leaseExpiresAt: null })
        .where(and(eq(feedbackPipeline.feedbackId, row.feedbackId), eq(feedbackPipeline.leaseToken, row.leaseToken!)));
      const [locked] = await tx.select().from(versions).where(eq(versions.name, 'feedback_runner_lease')).for('update');
      if (locked && (JSON.parse(locked.version ?? '{}') as { token?: string }).token === row.leaseToken)
        await tx.update(versions).set({ version: '{}', updatedAt: new Date().toISOString() }).where(eq(versions.name, 'feedback_runner_lease'));
    });
  }
}

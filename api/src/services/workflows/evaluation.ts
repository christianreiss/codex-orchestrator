import { and, eq } from 'drizzle-orm';
import { workflowRunEvaluations, workflowRunInvitations, workflowRunEvents } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import type { MutationInput, WorkflowCollaboration } from './contract.js';
import { syncGroup } from './members.js';
import {
  coordinator,
  knownEvidence,
  definition,
  event,
  expect,
  patchRun,
  pinned,
  publish,
  tasks,
  type Run,
  type Session,
} from './store.js';
export async function evaluateRun(
  ctx: Session,
  run: Run,
  input: MutationInput<'run_evaluate'>,
  collaboration: WorkflowCollaboration | undefined,
) {
  await coordinator(ctx, run, input.coordinator_generation);
  expect(run.version, input.expected_run_version, 'workflow_run_version_conflict');
  if (run.status !== 'evaluating')
    throw new ConflictError('Finish execution before evaluating', 'workflow_evaluation_pending');
  const [evaluation] = await ctx.tx
    .select()
    .from(workflowRunEvaluations)
    .where(eq(workflowRunEvaluations.runId, run.id))
    .for('update');
  if (!evaluation) throw new NotFoundError('Evaluation not found');
  expect(evaluation.version, input.expected_evaluation_version, 'workflow_evaluation_version_conflict');
  const doc = await pinned(ctx, run),
    list = await tasks(ctx, run);
  const eventRows = await ctx.tx
    .select({ id: workflowRunEvents.id })
    .from(workflowRunEvents)
    .where(eq(workflowRunEvents.runId, run.id));
  const evidenceIds = await knownEvidence(ctx, run);
  for (const finding of input.evaluation.findings) {
    if (finding.task_ids?.some((id) => !doc.tasks.some((t) => t.id === id)))
      throw new ValidationError('Unknown task in evaluation', { param: 'evaluation.findings' });
    if (finding.event_ids?.some((id) => !eventRows.some((e) => e.id === id)))
      throw new ValidationError('Unknown event in evaluation', { param: 'evaluation.findings' });
    if (finding.evidence_ids?.some((id) => !evidenceIds.has(id)))
      throw new ValidationError('Unknown evidence in evaluation', { param: 'evaluation.findings' });
  }
  const nextVersion = evaluation.version + 1;
  const draft = { ...input.evaluation };
  let appliedVersion: number | null = null;
  if (input.action === 'finalize') {
    if (draft.decision === 'revise') {
      const workflow = await definition(ctx.tx, run.workflowId, true);
      if (workflow.currentVersion !== draft.expected_workflow_version) {
        await ctx.tx
          .update(workflowRunEvaluations)
          .set({ status: 'draft', version: nextVersion, draft, actor: { ...ctx.actor }, updatedAt: ctx.now })
          .where(eq(workflowRunEvaluations.runId, run.id));
        await event(ctx, run, 'evaluation.conflict', {
          evaluation_version: nextVersion,
          current_workflow_version: workflow.currentVersion,
        });
        return {
          run,
          evaluation: { version: nextVersion, status: 'draft', draft, applied_version: null },
          conflict: {
            code: 'workflow_version_conflict',
            message: 'Workflow changed; evaluation draft was retained',
            extra: { current_version: workflow.currentVersion, evaluation_version: nextVersion },
          },
        };
      }
      const revision = await publish(
        ctx,
        workflow,
        draft.document!,
        draft.reason,
        draft.expected_workflow_version!,
        run.id,
      );
      if (revision.changed) appliedVersion = revision.version.version;
      else {
        draft.decision = 'no_change';
        draft.reason = `Already included: ${draft.reason}`;
      }
    }
    await ctx.tx
      .update(workflowRunInvitations)
      .set({ status: 'revoked', updatedAt: ctx.now })
      .where(and(eq(workflowRunInvitations.runId, run.id), eq(workflowRunInvitations.status, 'pending')));
    await syncGroup(ctx, run, collaboration, true);
    await ctx.tx
      .update(workflowRunEvaluations)
      .set({
        status: 'final',
        version: nextVersion,
        draft,
        appliedVersion,
        actor: { ...ctx.actor },
        finalizedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .where(eq(workflowRunEvaluations.runId, run.id));
    await patchRun(ctx, run, {
      status: 'completed',
      completedAt: ctx.now,
      report: {
        report_schema_version: 1,
        run_id: run.id,
        workflow_id: run.workflowId,
        workflow_version: run.workflowVersion,
        workflow_sha256: run.workflowSha256,
        outcome: run.outcome,
        summary: run.summary,
        results: run.results,
        criteria: run.criteria,
        open_items: run.openItems,
        tasks: list.map((t) => ({
          task_id: t.taskId,
          status: t.status,
          attempt_no: t.attemptNo,
          skip_reason: t.skipReason,
        })),
        evaluation: {
          version: nextVersion,
          decision: draft.decision,
          reason: draft.reason,
          applied_version: appliedVersion,
        },
        completed_at: ctx.now,
      },
    });
  } else
    await ctx.tx
      .update(workflowRunEvaluations)
      .set({ status: 'draft', version: nextVersion, draft, actor: { ...ctx.actor }, updatedAt: ctx.now })
      .where(eq(workflowRunEvaluations.runId, run.id));
  await event(ctx, run, `evaluation.${input.action}`, {
    evaluation_version: nextVersion,
    decision: draft.decision,
    applied_version: appliedVersion,
  });
  return {
    evaluation: {
      version: nextVersion,
      status: input.action === 'finalize' ? 'final' : 'draft',
      draft,
      applied_version: appliedVersion,
    },
    run,
  };
}

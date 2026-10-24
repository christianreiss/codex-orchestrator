import {workflowState} from './owner.js';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { workflowRunEvents } from '../../db/schema.js';
import { ValidationError } from '../../http/errors.js';
import { digest, type MutationInput, type WorkflowActor, type WorkflowDocument } from './contract.js';
import type { Run, Session } from './store.js';

export type KnowledgeSource = NonNullable<MutationInput<'run_note'>['source']>;
type Knowledge = WorkflowDocument['knowledge'][number];
export function knowledgeUri(run: Pick<Run, 'workflowSha256'>, knowledge: Knowledge) {
  return knowledge.reference?.uri ?? `workflow://${run.workflowSha256}/knowledge/${knowledge.id}`;
}
export function requiredKnowledge(document: WorkflowDocument, taskId: string) {
  const ids = document.tasks.find((t) => t.id === taskId)?.knowledge_ids ?? [];
  return document.knowledge.filter((k) => ids.includes(k.id) && k.required_check);
}

/** A receipt is an attributed agent attestation, not independent verification of a URL. */
export function validateKnowledgeReceipt(
  document: WorkflowDocument,
  run: Pick<Run, 'createdAt' | 'workflowSha256'>,
  input: MutationInput<'run_note'>,
  now: string,
) {
  const source = input.source;
  if (!source?.knowledge_id) return; // Historical, informational source notes remain valid.
  const fail = (message: string) => {
    throw new ValidationError(message, { param: 'source' });
  };
  if (input.kind !== 'knowledge') fail('A knowledge receipt must use kind knowledge');
  const knowledge = document.knowledge.find((k) => k.id === source.knowledge_id);
  if (!knowledge) return fail('Unknown pinned knowledge_id');
  if (
    input.task_id &&
    !document.tasks.find((t) => t.id === input.task_id)?.knowledge_ids.includes(knowledge.id)
  )
    fail('The task does not reference this knowledge_id');
  if (source.uri !== knowledgeUri(run, knowledge)) fail('Receipt URI must match the pinned knowledge source');
  const time = Date.parse(source.read_at);
  if (time < Date.parse(run.createdAt) || time > Date.parse(now))
    fail('Receipt read_at must be within this run and cannot be in the future');
  if (!source.applicability || !source.applicability_reason?.trim())
    fail('Knowledge receipts need applicability and applicability_reason');
  // Unavailable sources and mismatches are retained as explicit blockers, even without a fingerprint.
  if (source.applicability === 'applicable' && !source.unavailable) {
    if (!source.digest?.trim() && !source.revision?.trim())
      fail('Applicable receipts need digest or revision');
    if (knowledge.inline !== undefined && source.digest !== digest(knowledge.inline))
      fail('Inline receipt digest must match the pinned inline content');
  }
}

export function receiptBlocker(source?: KnowledgeSource | null) {
  if (!source) return 'missing_receipt';
  if (source.unavailable) return 'source_unavailable';
  if (source.applicability !== 'applicable')
    return source.applicability === 'mismatch' ? 'applicability_mismatch' : 'applicability_unknown';
  return null;
}

export async function knowledgeChecks(
  ctx: Session,
  run: Run,
  document: WorkflowDocument,
  taskId: string,
  actor: WorkflowActor = ctx.actor,
) {
  return Promise.all(
    requiredKnowledge(document, taskId).map(async (knowledge) => {
      // The run row is locked during mutation, so notes and claim acquisition serialize.
      // One bounded lookup per source avoids reading the unbounded run event history.
      const state=workflowState();
      const receipt=state&&run.status!=='completed'?[...state.table('workflowRunEvents').by('runId',run.id)].filter(r=>r.type==='note.knowledge'&&(r.detail.source as KnowledgeSource|undefined)?.knowledge_id===knowledge.id&&(r.detail.task_id==null||r.detail.task_id===taskId)&&r.actor.address_id===(actor.address_id??'')&&r.actor.session_id===(actor.session_id??'')&&r.actor.binding_generation===(actor.binding_generation??0)).sort((a,b)=>Number(b.detail.task_id===taskId)-Number(a.detail.task_id===taskId)||b.sequence-a.sequence)[0]:(await ctx.tx
        .select()
        .from(workflowRunEvents)
        .where(
          and(
            eq(workflowRunEvents.runId, run.id),
            eq(workflowRunEvents.type, 'note.knowledge'),
            sql`JSON_UNQUOTE(JSON_EXTRACT(${workflowRunEvents.detail}, '$.source.knowledge_id')) = ${knowledge.id}`,
            or(
              isNull(sql`JSON_UNQUOTE(JSON_EXTRACT(${workflowRunEvents.detail}, '$.task_id'))`),
              sql`JSON_EXTRACT(${workflowRunEvents.detail}, '$.task_id') = CAST('null' AS JSON)`,
              sql`JSON_UNQUOTE(JSON_EXTRACT(${workflowRunEvents.detail}, '$.task_id')) = ${taskId}`,
            ),
            sql`JSON_UNQUOTE(JSON_EXTRACT(${workflowRunEvents.actor}, '$.address_id')) = ${actor.address_id ?? ''}`,
            sql`JSON_UNQUOTE(JSON_EXTRACT(${workflowRunEvents.actor}, '$.session_id')) = ${actor.session_id ?? ''}`,
            sql`JSON_EXTRACT(${workflowRunEvents.actor}, '$.binding_generation') = ${actor.binding_generation ?? 0}`,
          ),
        )
        .orderBy(
          // A task-specific assessment is more precise than a later general read.
          // It must be corrected for this task, never cleared by a run-wide receipt.
          desc(
            sql`CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(${workflowRunEvents.detail}, '$.task_id')) = ${taskId} THEN 1 ELSE 0 END`,
          ),
          desc(workflowRunEvents.sequence),
        )
        .limit(1))[0];
      const source = (receipt?.detail as { source?: KnowledgeSource } | undefined)?.source;
      return {
        knowledge_id: knowledge.id,
        title: knowledge.title,
        uri: knowledgeUri(run, knowledge),
        applicability: knowledge.required_check!.applicability,
        blocker: receiptBlocker(source),
        receipt: receipt
          ? { event_id: receipt.id, actor: receipt.actor, source, recorded_at: receipt.createdAt }
          : null,
      };
    }),
  );
}

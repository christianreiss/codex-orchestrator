import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { ConflictError, ValidationError } from '../../http/errors.js';

export const WORKFLOWS_ENABLED_KEY = 'workflows_enabled';
export const WORKFLOW_PROTOCOL_VERSION = 2;
export const WORKFLOW_LEASE_MS = 30 * 60 * 1000;
export const WORKFLOW_LIMITS = {
  tasks: 200,
  knowledge: 100,
  inputs: 64,
  members: 32,
  documentBytes: 512 * 1024,
  textBytes: 64 * 1024,
  page: 100,
} as const;
export interface WorkflowActor {
  kind: 'agent' | 'admin';
  id: string;
  address_id?: string;
  session_id?: string;
  binding_generation?: number;
  host_id?: number;
  engine?: string;
  name?: string;
  protocol_version?: number;
}
export type WorkflowTx = Parameters<Parameters<Database['transaction']>[0]>[0];
export interface WorkflowCollaboration {
  lock(tx: WorkflowTx, actor: WorkflowActor): Promise<void>;
  resolveTarget(tx: WorkflowTx, addressId: string): Promise<WorkflowActor>;
  invite(
    tx: WorkflowTx,
    input: {
      actor: WorkflowActor;
      target: WorkflowActor;
      invitation_id: string;
      run_id: string;
      goal: unknown;
      reason: string;
      task_ids: string[];
      report_url: string;
      client_request_id: string;
    },
  ): Promise<{ message_id: string }>;
  syncGroup(
    tx: WorkflowTx,
    input: { run_id: string; group_id: string | null; members: WorkflowActor[]; closed: boolean },
  ): Promise<{ group_id: string; room_id: string; group_topic: string; communication_url: string } | null>;
  notifyCancel?(
    tx: WorkflowTx,
    input: {
      actor: WorkflowActor;
      run_id: string;
      members: WorkflowActor[];
      reason: string;
      client_request_id: string;
    },
  ): Promise<{
    deliveries: { address_id: string; message_id: string }[];
    skipped: { address_id: string; reason: string }[];
  }>;
}
const text = z
  .string()
  .max(WORKFLOW_LIMITS.textBytes)
  .refine((v) => Buffer.byteLength(v) <= WORKFLOW_LIMITS.textBytes, 'Text exceeds 64 KiB');
const nonempty = text.refine((v) => v.trim().length > 0, 'Must not be blank');
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const uuid = z.string().uuid();
const revision = z.number().int().positive();
const data = z.record(z.unknown()).superRefine((v, ctx) => {
  if (Buffer.byteLength(JSON.stringify(v)) > WORKFLOW_LIMITS.textBytes)
    ctx.addIssue({ code: 'custom', message: 'Data exceeds 64 KiB' });
});
function validWebUri(value: string) {
  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
}
export const referenceUri = z
  .string()
  .max(2048)
  .refine(
    (v) =>
      /^(shared:\/\/[^\s]+|project:\/\/[^\s]+\/(memory|files)\/[^\s]+|skill:\/\/[^\s]+|https?:\/\/[^\s]+)$/.test(
        v,
      ) &&
      Array.from(v).every((char) => char.charCodeAt(0) > 32) &&
      (!/^https?:/.test(v) || validWebUri(v)),
    'Use shared://, project://…/memory/… or /files/…, skill://, http:// or https://',
  );
const inputSchema = z
  .object({
    key: id,
    label: z.string().min(1).max(255),
    type: z.enum(['string', 'number', 'boolean', 'enum']),
    required: z.boolean(),
    default: z.unknown().optional(),
    options: z.array(z.string().min(1)).min(1).max(100).optional(),
    description: text.optional(),
  })
  .strict();
const taskSchema = z
  .object({
    id,
    title: z.string().min(1).max(255),
    instructions: nonempty,
    acceptance_criteria: z.array(nonempty).min(1).max(100),
    depends_on: z.array(id).max(200),
    knowledge_ids: z.array(id).max(100),
    execution_hint: text.optional(),
  })
  .strict();
const knowledgeSchema = z
  .object({
    id,
    title: z.string().min(1).max(255),
    inline: text.optional(),
    reference: z.object({ uri: referenceUri, read_hint: text.optional() }).strict().optional(),
    required_check: z.object({ applicability: nonempty }).strict().optional(),
  })
  .strict()
  .refine(
    (v) => (v.inline !== undefined) !== (v.reference !== undefined),
    'Exactly one of inline or reference is required',
  );
export const workflowDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    title: z.string().trim().min(1).max(255),
    summary: text,
    goal: z
      .object({
        statement: nonempty,
        success_criteria: z
          .array(z.object({ id, text: nonempty }).strict())
          .min(1)
          .max(100),
      })
      .strict(),
    inputs: z.array(inputSchema).max(64),
    tasks: z.array(taskSchema).min(1).max(200),
    knowledge: z.array(knowledgeSchema).max(100),
  })
  .strict()
  .superRefine((d, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (Buffer.byteLength(JSON.stringify(d)) > WORKFLOW_LIMITS.documentBytes)
      issue([], 'Document exceeds 512 KiB');
    for (const [name, ids] of [
      ['tasks', d.tasks.map((x) => x.id)],
      ['knowledge', d.knowledge.map((x) => x.id)],
      ['inputs', d.inputs.map((x) => x.key)],
      ['goal', d.goal.success_criteria.map((x) => x.id)],
    ] as const)
      if (new Set(ids).size !== ids.length) issue([name], 'IDs must be unique');
    const taskIds = new Set(d.tasks.map((t) => t.id)),
      knowledgeIds = new Set(d.knowledge.map((k) => k.id));
    d.tasks.forEach((t, i) => {
      if (new Set(t.depends_on).size !== t.depends_on.length)
        issue(['tasks', i, 'depends_on'], 'Duplicate dependency');
      for (const ref of t.depends_on)
        if (ref === t.id || !taskIds.has(ref)) issue(['tasks', i, 'depends_on'], `Invalid dependency ${ref}`);
      for (const ref of t.knowledge_ids)
        if (!knowledgeIds.has(ref)) issue(['tasks', i, 'knowledge_ids'], `Unknown knowledge ${ref}`);
    });
    const done = new Set<string>(),
      active = new Set<string>();
    const visit = (key: string): boolean => {
      if (active.has(key)) return false;
      if (done.has(key)) return true;
      active.add(key);
      for (const dep of d.tasks.find((t) => t.id === key)?.depends_on ?? []) if (!visit(dep)) return false;
      active.delete(key);
      done.add(key);
      return true;
    };
    if (d.tasks.some((t) => !visit(t.id))) issue(['tasks'], 'Dependencies contain a cycle');
    d.inputs.forEach((input, i) => {
      if (input.type === 'enum' && !input.options?.length)
        issue(['inputs', i, 'options'], 'Enum options required');
      if (input.default !== undefined && !inputValid(input, input.default))
        issue(['inputs', i, 'default'], 'Default does not match input type');
    });
  });
export type WorkflowDocument = z.infer<typeof workflowDocumentSchema>;
function inputValid(input: z.infer<typeof inputSchema>, value: unknown) {
  return input.type === 'enum'
    ? typeof value === 'string' && !!input.options?.includes(value)
    : input.type === 'number'
      ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === input.type;
}
export function validateInputs(document: WorkflowDocument, values: Record<string, unknown>, partial = false) {
  const out = { ...values };
  for (const key of Object.keys(out))
    if (!document.inputs.some((i) => i.key === key))
      throw new ValidationError(`Unknown input ${key}`, { param: `inputs.${key}` });
  for (const input of document.inputs) {
    if (out[input.key] === undefined && input.default !== undefined) out[input.key] = input.default;
    if (out[input.key] === undefined) {
      if (input.required && !partial)
        throw new ValidationError(`Missing input ${input.key}`, { param: `inputs.${input.key}` });
    } else if (!inputValid(input, out[input.key]) || (!partial && input.required && typeof out[input.key] === 'string' && !(out[input.key] as string).trim()))
      throw new ValidationError(`Invalid input ${input.key}`, { param: `inputs.${input.key}` });
  }
  return out;
}
export const clarificationQuestionSchema = z.object({
  id,
  question: nonempty,
  answer: text.optional(),
}).strict();
export type ClarificationQuestion = z.infer<typeof clarificationQuestionSchema>;
export interface WorkflowPreparation {
  phase: 'clarifying' | 'awaiting_confirmation' | 'ready';
  revision: number;
  notes: string;
  questions: ClarificationQuestion[];
  summary: {
    revision: number;
    title: string;
    goal: string;
    inputs: Record<string, unknown>;
    questions: ClarificationQuestion[];
    tasks: { id: string; title: string; instructions: string; acceptance_criteria: string[] }[];
    notes: string;
  } | null;
  confirmation: {
    summary_revision: number;
    actor: WorkflowActor;
    time: string;
    channel: 'web' | 'conversation';
    user_confirmation: string;
  } | null;
}
export function requireWorkflowProtocol(actor: WorkflowActor) {
  if (actor.kind === 'agent' && (actor.protocol_version ?? 1) < WORKFLOW_PROTOCOL_VERSION)
    throw new ConflictError('Update this agent wrapper for workflow clarification protocol 2', 'workflow_wrapper_outdated');
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function digest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function documentDiff(before: WorkflowDocument, after: WorkflowDocument) {
  return (Object.keys(after) as (keyof WorkflowDocument)[])
    .filter((k) => canonical(before[k]) !== canonical(after[k]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}
export const evidenceSchema = z
  .object({
    id,
    description: nonempty,
    type: z.string().min(1).max(64),
    time: z.string().datetime(),
    uri: referenceUri.optional(),
    hash: z.string().max(128).optional(),
    execution_host: z.string().max(255).optional(),
    expires_at: z.string().datetime().optional(),
  })
  .strict();
export type WorkflowEvidence = z.infer<typeof evidenceSchema>;
const evidence = z.array(evidenceSchema).max(200);
const base = { client_request_id: uuid };
const run = { ...base, run_id: uuid };
const control = { ...run, expected_run_version: revision, coordinator_generation: revision.optional() };
const task = { ...run, task_id: id, expected_task_version: revision };
const token = { claim_token: z.string().min(20).max(256), claim_generation: revision };
const evaluation = z
  .object({
    findings: z
      .array(
        z
          .object({
            text: nonempty,
            task_ids: z.array(id).optional(),
            event_ids: z.array(uuid).optional(),
            evidence_ids: z.array(id).optional(),
          })
          .strict(),
      )
      .max(200),
    lessons: z.array(nonempty).max(100),
    decision: z.enum(['no_change', 'revise']),
    reason: nonempty,
    document: workflowDocumentSchema.optional(),
    expected_workflow_version: revision.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.decision === 'revise' && (!v.document || !v.expected_workflow_version))
      c.addIssue({ code: 'custom', message: 'Revision needs document and expected_workflow_version' });
  });
export const workflowMutationSchemas = {
  state: z.object({ ...base, enabled: z.boolean() }).strict(),
  create: z
    .object({
      ...base,
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      document: workflowDocumentSchema,
      reason: nonempty,
    })
    .strict(),
  revise: z
    .object({
      ...base,
      workflow_id: z.string().min(1),
      expected_workflow_version: revision,
      document: workflowDocumentSchema,
      reason: nonempty,
      source_run_id: uuid.optional(),
    })
    .strict(),
  archive: z
    .object({
      ...base,
      workflow_id: z.string().min(1),
      expected_workflow_version: revision,
      expected_control_version: revision,
      action: z.enum(['archive', 'restore']),
      reason: nonempty,
    })
    .strict(),
  revert: z
    .object({
      ...base,
      workflow_id: z.string().min(1),
      expected_workflow_version: revision,
      version: revision,
      reason: nonempty,
    })
    .strict(),
  run_create: z
    .object({
      ...base,
      workflow_id: z.string().min(1),
      version: z.union([revision, z.literal('latest')]).default('latest'),
      title: z.string().min(1).max(255),
      inputs: data.default({}),
    })
    .strict(),
  run_control: z.discriminatedUnion('action', [
    z
      .object({
        ...control,
        action: z.literal('configure'),
        title: z.string().min(1).max(255).optional(),
        inputs: data.optional(),
        questions: z.array(clarificationQuestionSchema).max(64).refine(v => Buffer.byteLength(JSON.stringify(v)) <= WORKFLOW_LIMITS.textBytes, 'Questions exceed 64 KiB').optional(),
      })
      .strict(),
    z.object({ ...control, action: z.literal('present_summary'), notes: text.default('') }).strict(),
    z.object({ ...control, action: z.literal('confirm_summary'), summary_revision: revision,
      user_confirmation: nonempty.optional() }).strict(),
    ...(['start', 'coordinator_acquire', 'coordinator_renew'] as const).map((action) =>
      z.object({ ...control, action: z.literal(action) }).strict(),
    ),
    ...(['pause', 'resume', 'block', 'request_cancel'] as const).map((action) =>
      z.object({ ...control, action: z.literal(action), reason: nonempty }).strict(),
    ),
    z
      .object({
        ...control,
        action: z.literal('coordinator_transfer'),
        target_address_id: uuid,
        reason: nonempty,
      })
      .strict(),
    z
      .object({
        ...control,
        action: z.literal('coordinator_recover'),
        target_address_id: uuid,
        reason: nonempty,
      })
      .strict(),
  ]),
  task_claim: z.discriminatedUnion('action', [
    z.object({ ...task, action: z.literal('acquire') }).strict(),
    z.object({ ...task, ...token, action: z.literal('renew') }).strict(),
    z.object({ ...task, ...token, action: z.literal('release'), reason: nonempty }).strict(),
    z
      .object({
        ...task,
        action: z.literal('reconcile'),
        stage: z.enum(['begin', 'resolve']),
        claim_token: z.string().min(20).max(256).optional(),
        claim_generation: revision.optional(),
        resolution: z.enum(['verified_success', 'safe_to_retry', 'still_uncertain']).optional(),
        reason: nonempty,
        old_execution_stopped: z.boolean().optional(),
        evidence: evidence.optional(),
        outputs: data.optional(),
        execution_host: z.string().min(1).max(255).optional(),
      })
      .strict(),
  ]),
  task_update: z.discriminatedUnion('action', [
    z.object({ ...task, action: z.literal('retry'), reason: nonempty }).strict(),
    z
      .object({
        ...task,
        action: z.literal('skip'),
        reason: nonempty,
        skip_reason: z.literal('not_applicable'),
      })
      .strict(),
    z
      .object({
        ...task,
        ...token,
        action: z.literal('result'),
        status: z.enum(['succeeded', 'failed', 'blocked', 'uncertain']),
        summary: nonempty,
        outputs: data.default({}),
        evidence: evidence.default([]),
        error: text.optional(),
        execution_host: z.string().min(1).max(255),
      })
      .strict(),
  ]),
  run_note: z
    .object({
      ...run,
      kind: z.enum(['note', 'knowledge', 'improvement']),
      text: nonempty,
      task_id: id.optional(),
      evidence_ids: z.array(id).max(200).optional(),
      source: z
        .object({
          uri: z.union([referenceUri, z.string().regex(/^workflow:\/\/[a-f0-9]{64}\/knowledge\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)]),
          title: z.string().min(1).max(255),
          read_at: z.string().datetime(),
          digest: z.string().max(128).optional(),
          revision: z.string().max(128).optional(),
          summary: nonempty,
          unavailable: z.boolean().optional(),
          knowledge_id: id.optional(),
          applicability: z.enum(['applicable', 'mismatch', 'unknown']).optional(),
          applicability_reason: nonempty.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  run_finish: z
    .object({
      ...control,
      outcome: z.enum(['succeeded', 'partial', 'failed', 'canceled', 'unknown']),
      summary: nonempty,
      criteria: z
        .array(
          z
            .object({
              id,
              status: z.enum(['met', 'not_met', 'unverified']),
              reason: nonempty,
              evidence_ids: z.array(id),
            })
            .strict(),
        )
        .min(1)
        .max(100),
      results: data.default({}),
      open_items: z.array(nonempty).max(200).default([]),
      uncertain_task_ids: z.array(id).max(200).default([]),
    })
    .strict(),
  run_evaluate: z
    .object({
      ...control,
      action: z.enum(['save_draft', 'finalize']),
      expected_evaluation_version: revision,
      evaluation,
    })
    .strict(),
  invite: z
    .object({ ...run, target_address_id: uuid, reason: nonempty, task_ids: z.array(id).max(200).default([]) })
    .strict(),
  membership: z.discriminatedUnion('action', [
    z.object({ ...run, action: z.literal('accept'), invitation_id: uuid, reason: nonempty }).strict(),
    z.object({ ...run, action: z.literal('decline'), invitation_id: uuid, reason: nonempty }).strict(),
    z
      .object({ ...run, action: z.literal('revoke_invitation'), invitation_id: uuid, reason: nonempty })
      .strict(),
    z.object({ ...run, action: z.literal('leave'), reason: nonempty }).strict(),
    z.object({ ...control, action: z.literal('remove'), target_address_id: uuid, reason: nonempty }).strict(),
  ]),
  prepare_cancel: z.object({ ...run, expected_run_version: revision, reason: nonempty }).strict(),
} as const;
export type WorkflowOperation = keyof typeof workflowMutationSchemas;
export type MutationInput<K extends WorkflowOperation> = z.infer<(typeof workflowMutationSchemas)[K]>;
export const pageSchema = z.object({
  cursor: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

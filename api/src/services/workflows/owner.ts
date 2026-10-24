import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from '../../db/client.js';
import {
  ownerRuntimeFor,
  mutateOwnerState,
  type OwnerMutationContext,
  type OwnerRuntime,
} from '../../control-plane/state/runtime.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import type { OwnedTableName, StateRow } from '../../control-plane/state/catalog.js';
import type { Json } from '../../control-plane/commands.js';
import type { WorkflowTx } from './contract.js';

const reads = new AsyncLocalStorage<{ owner: OwnerRuntime; snapshot: OwnerStateSnapshot }>();
export function withWorkflowRead<T>(db: Database, run: () => T): T {
  const owner = ownerRuntimeFor(db);
  if (!owner) return run();
  owner.assertOwner();
  return reads.run({ owner, snapshot: owner.state.snapshot() }, run);
}
const context = new AsyncLocalStorage<{ owner: OwnerRuntime; command: OwnerMutationContext }>();
export const workflowOwnerContext = () => context.getStore();
export const workflowOwnerRuntime = () => context.getStore()?.owner ?? reads.getStore()?.owner;
export function workflowState(db?: Database): OwnerStateSnapshot | undefined {
  const active = context.getStore();
  if (active) return active.command.draft.view();
  const reading = reads.getStore();
  if (reading) return reading.snapshot;
  const owner = db ? ownerRuntimeFor(db) : undefined;
  owner?.assertOwner();
  return owner?.state.snapshot();
}
export async function workflowTransaction<T>(
  db: Database,
  kind: string,
  payload: Json,
  run: (tx: WorkflowTx) => Promise<T>,
  authorize?: (snapshot: OwnerStateSnapshot) => void,
): Promise<T> {
  const owner = ownerRuntimeFor(db);
  if (!owner) return db.transaction(run);
  let result: T;
  await mutateOwnerState(owner, {
    kind: `workflow.${kind}`,
    payload,
    authorize,
    prepare(command) {
      command.write(async (tx) => {
        result = await context.run({ owner, command }, () => run(tx as WorkflowTx));
      });
      return () => result as Json;
    },
  });
  return result!;
}
/** Explicit publication paired with domain SQL; this helper never interprets SQL predicates. */
export function publishWorkflowRow<N extends OwnedTableName>(name: N, row: StateRow<N>) {
  context.getStore()?.command.draft.upsert(name, row);
}
export function patchWorkflowRow<N extends OwnedTableName>(name: N, id: string, patch: Partial<StateRow<N>>) {
  const active = context.getStore();
  if (!active) return;
  const row = active.command.draft.table(name).get(id);
  if (!row) throw new Error(`Missing ${name} metadata for workflow mutation`);
  active.command.draft.upsert(name, { ...row, ...patch } as StateRow<N>);
}

type WorkflowTable =
  | 'workflows'
  | 'workflowVersions'
  | 'workflowRuns'
  | 'workflowRunMembers'
  | 'workflowRunInvitations'
  | 'workflowRunTasks'
  | 'workflowTaskAttempts'
  | 'workflowRunEvaluations';
const defaults = {
  workflows: { status: 'active', currentVersion: 1, controlVersion: 1 },
  workflowVersions: { previousVersionId: null, sourceRunId: null },
  workflowRuns: {
    coordinatorOwnershipMode: 'timed',
    coordinatorSessionId: null,
    coordinatorBindingGeneration: null,
    coordinatorNativeInstanceId: null,
  },
  workflowRunMembers: { reason: null },
  workflowRunInvitations: { messageId: null },
  workflowRunTasks: {
    claimOwnershipMode: 'timed',
    claimNativeInstanceId: null,
    status: 'pending',
    version: 1,
    attemptNo: 0,
    claimOwnerAddressId: null,
    claimSessionId: null,
    claimBindingGeneration: null,
    claimGeneration: 0,
    claimTokenHash: null,
    claimLeaseUntil: null,
    claimRecovery: 0,
    skipReason: null,
    reason: null,
    outputs: null,
    evidence: null,
  },
  workflowTaskAttempts: {
    executionHost: null,
    summary: null,
    outputs: null,
    evidence: null,
    error: null,
    endedAt: null,
  },
  workflowRunEvaluations: {
    version: 1,
    status: 'pending',
    draft: null,
    appliedVersion: null,
    actor: null,
    finalizedAt: null,
  },
} satisfies Record<WorkflowTable, Record<string, unknown>>;

export async function workflowInsert<N extends WorkflowTable>(
  tx: WorkflowTx,
  name: N,
  input: (typeof schema)[N]['$inferInsert'],
) {
  const row = { ...defaults[name], ...input };
  switch (name) {
    case 'workflows':
      await tx.insert(schema.workflows).values(row as typeof schema.workflows.$inferInsert);
      break;
    case 'workflowVersions':
      await tx.insert(schema.workflowVersions).values(row as typeof schema.workflowVersions.$inferInsert);
      break;
    case 'workflowRuns':
      await tx.insert(schema.workflowRuns).values(row as typeof schema.workflowRuns.$inferInsert);
      break;
    case 'workflowRunMembers':
      await tx.insert(schema.workflowRunMembers).values(row as typeof schema.workflowRunMembers.$inferInsert);
      break;
    case 'workflowRunInvitations':
      await tx
        .insert(schema.workflowRunInvitations)
        .values(row as typeof schema.workflowRunInvitations.$inferInsert);
      break;
    case 'workflowRunTasks':
      await tx.insert(schema.workflowRunTasks).values(row as typeof schema.workflowRunTasks.$inferInsert);
      break;
    case 'workflowTaskAttempts':
      await tx
        .insert(schema.workflowTaskAttempts)
        .values(row as typeof schema.workflowTaskAttempts.$inferInsert);
      break;
    case 'workflowRunEvaluations':
      await tx
        .insert(schema.workflowRunEvaluations)
        .values(row as typeof schema.workflowRunEvaluations.$inferInsert);
      break;
  }
  context.getStore()?.command.draft.upsert(name, row as StateRow<N>);
}

export async function workflowPatch<N extends WorkflowTable>(
  tx: WorkflowTx,
  name: N,
  id: string,
  patch: Partial<(typeof schema)[N]['$inferSelect']>,
) {
  switch (name) {
    case 'workflows':
      await tx
        .update(schema.workflows)
        .set(patch as Partial<typeof schema.workflows.$inferSelect>)
        .where(eq(schema.workflows.id, id));
      break;
    case 'workflowVersions':
      await tx
        .update(schema.workflowVersions)
        .set(patch as Partial<typeof schema.workflowVersions.$inferSelect>)
        .where(eq(schema.workflowVersions.id, id));
      break;
    case 'workflowRuns':
      await tx
        .update(schema.workflowRuns)
        .set(patch as Partial<typeof schema.workflowRuns.$inferSelect>)
        .where(eq(schema.workflowRuns.id, id));
      break;
    case 'workflowRunMembers':
      await tx
        .update(schema.workflowRunMembers)
        .set(patch as Partial<typeof schema.workflowRunMembers.$inferSelect>)
        .where(eq(schema.workflowRunMembers.id, id));
      break;
    case 'workflowRunInvitations':
      await tx
        .update(schema.workflowRunInvitations)
        .set(patch as Partial<typeof schema.workflowRunInvitations.$inferSelect>)
        .where(eq(schema.workflowRunInvitations.id, id));
      break;
    case 'workflowRunTasks':
      await tx
        .update(schema.workflowRunTasks)
        .set(patch as Partial<typeof schema.workflowRunTasks.$inferSelect>)
        .where(eq(schema.workflowRunTasks.id, id));
      break;
    case 'workflowTaskAttempts':
      await tx
        .update(schema.workflowTaskAttempts)
        .set(patch as Partial<typeof schema.workflowTaskAttempts.$inferSelect>)
        .where(eq(schema.workflowTaskAttempts.id, id));
      break;
    case 'workflowRunEvaluations':
      await tx
        .update(schema.workflowRunEvaluations)
        .set(patch as Partial<typeof schema.workflowRunEvaluations.$inferSelect>)
        .where(eq(schema.workflowRunEvaluations.runId, id));
      break;
  }
  patchWorkflowRow(name, id, patch as Partial<StateRow<N>>);
}

import { ownerPresence } from '../../control-plane/presence.js';
import { ownerHistoryCandidates } from './ram.js';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { agentSessions, versions } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import { requireOwnerRuntime, mutateOwnerState } from '../../control-plane/state/runtime.js';
import type { Database } from '../../db/client.js';
import { authoritativeSnapshot, executeColdRead } from '../../db/fresh-read.js';
import type { PersistenceTransaction } from '../../control-plane/persistence.js';
import { wsPublisher } from '../../ws/publisher.js';
import { ownerRetention } from './owner.js';
import { RETENTION_FAMILIES } from './deadlines.js';
import { coldPreview } from './cold.js';
import {
  RETENTION_POLICY_KEY,
  RETENTION_RUN_KEY,
  serverRetentionPolicy,
  retentionRevision,
  validateServerRetention,
} from './policy.js';

export const MANUAL_RETENTION_FAMILIES = RETENTION_FAMILIES.filter(
  (f) => !['turns', 'credentials'].includes(f),
);
export function retentionStatus(db: Database) {
  const runtime = requireOwnerRuntime(db),
    snapshot = runtime.state.snapshot();
  const policy = serverRetentionPolicy(snapshot);
  return {
    policy,
    revision: retentionRevision(policy),
    observed_at: new Date().toISOString(),
    limits: { audit_days: [1, 3650], history_hours: [1, 87600], quota_days: [1, 3650] },
    fixed: {
      receipt_result_days: 14,
      internal_receipt_days: 7,
      docker_max_files: 3,
      docker_file_mb: 10,
      docker_age_limit: false,
    },
    run: JSON.parse(snapshot.setting(RETENTION_RUN_KEY) ?? 'null') as Record<string, unknown> | null,
    obligations: ownerRetention(runtime)
      .obligations()
      .map((v) => ({
        family: v.key.slice(8),
        due_at: v.dueAt > 0 ? new Date(v.dueAt).toISOString() : null,
        due: v.dueAt <= Date.now(),
      })),
  };
}
export async function saveRetentionPolicy(db: Database, input: unknown) {
  const body = input as { policy?: unknown; expected_revision?: string };
  const policy = validateServerRetention(body?.policy);
  const runtime = requireOwnerRuntime(db);
  await mutateOwnerState(runtime, {
    kind: 'retention.policy',
    payload: { policy: { ...policy }, expected_revision: body.expected_revision ?? null },
    prepare(context) {
      const previous = serverRetentionPolicy(context.snapshot);
      if (body.expected_revision !== retentionRevision(previous))
        throw new ConflictError(
          'Retention policy changed; reload the effective policy',
          'retention_policy_changed',
        );
      const at = new Date().toISOString();
      const row = { name: RETENTION_POLICY_KEY, version: JSON.stringify(policy), updatedAt: at };
      context.draft.upsert('versions', row);
      context.write((tx) =>
        tx
          .insert(versions)
          .values(row)
          .onDuplicateKeyUpdate({ set: { version: row.version, updatedAt: at } }),
      );
      if (policy.history_hours !== previous.history_hours) {
        for (const session of context.snapshot.sessions.all()) {
          if (!session.endedAt) continue;
          const end = Date.parse(session.endedAt);
          if (!Number.isFinite(end)) continue;
          const expiresAt = new Date(end + policy.history_hours * 3600000).toISOString();
          context.draft.upsert('agentSessions', { ...session, expiresAt });
          context.write((tx) =>
            tx.update(agentSessions).set({ expiresAt }).where(eq(agentSessions.id, session.id)),
          );
        }
      }
      return null;
    },
  });
  wsPublisher.publish('settings.changed', { key: RETENTION_POLICY_KEY });
  return retentionStatus(db);
}
export async function previewRetention(db: Database) {
  const runtime = requireOwnerRuntime(db),
    policy = serverRetentionPolicy(runtime.state.snapshot());
  const tx = {
    execute: (query: Parameters<Database['execute']>[0]) => executeColdRead(db, query),
  } as PersistenceTransaction;
  const families = await authoritativeSnapshot(db, async () => {
    const result = await coldPreview(tx, policy);
    const now = new Date().toISOString(),
      cutoff = new Date(Date.parse(now) - policy.history_hours * 3600000).toISOString();
    const snapshot = runtime.state.snapshot(),
      candidates = ownerHistoryCandidates(snapshot, cutoff, now, ownerPresence(runtime), false);
    for (const family of ['portal', 'conversations'] as const) {
      const eligible = candidates[family]().length;
      const total =
        family === 'portal' ? snapshot.sessions.size : snapshot.table('agentBusConversations').size;
      result[family] = { eligible, retained: total - eligible };
    }
    return result;
  });
  runtime.assertOwner();
  if (retentionRevision(policy) !== retentionRevision(serverRetentionPolicy(runtime.state.snapshot())))
    throw new ConflictError('Retention policy changed during preview', 'retention_policy_changed');
  const snapshot = runtime.state.snapshot();
  return {
    observed_at: new Date().toISOString(),
    revision: retentionRevision(policy),
    families,
    history: {
      sessions: snapshot.sessions.all().length,
      messages: snapshot.messages.all().length,
      note: 'Rooms, addresses and attachments are checked in bounded lifecycle batches. Retained includes younger and protected records. All candidates are rechecked before deletion.',
    },
  };
}
export async function requestRetentionRun(db: Database, input: unknown) {
  const body = input as { client_request_id?: string; expected_revision?: string };
  if (
    !body ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      body.client_request_id ?? '',
    )
  )
    throw new ValidationError('client_request_id must be a UUID');
  const runtime = requireOwnerRuntime(db);
  let created = false;
  await mutateOwnerState(runtime, {
    kind: 'retention.run.request',
    id: body.client_request_id,
    payload: { expected_revision: body.expected_revision ?? null },
    prepare(context) {
      const policy = serverRetentionPolicy(context.snapshot);
      if (body.expected_revision !== retentionRevision(policy))
        throw new ConflictError('Retention policy changed; refresh the preview', 'retention_policy_changed');
      if (!policy.armed)
        throw new ConflictError(
          'Activate automatic server cleanup before starting a run',
          'retention_not_armed',
        );
      const previous = JSON.parse(context.snapshot.setting(RETENTION_RUN_KEY) ?? '{}') as {
        id?: string;
        status?: string;
      };
      if (previous.status === 'running' && previous.id !== body.client_request_id)
        throw new ConflictError('A retention run is already active', 'retention_running');
      created = true;
      const at = new Date().toISOString(),
        id = body.client_request_id ?? randomUUID();
      const row = {
        name: RETENTION_RUN_KEY,
        version: JSON.stringify({ id, status: 'running', started_at: at, families: {}, counts: {} }),
        updatedAt: at,
      };
      context.draft.upsert('versions', row);
      context.write((tx) =>
        tx
          .insert(versions)
          .values(row)
          .onDuplicateKeyUpdate({ set: { version: row.version, updatedAt: at } }),
      );
      return { id };
    },
  });
  const run = retentionStatus(db).run;
  if (run?.id !== body.client_request_id)
    throw new NotFoundError(
      'This bounded status slot no longer contains the requested run',
      'retention_run_not_found',
    );
  if (created && run && run.id === body.client_request_id && run.status === 'running')
    ownerRetention(runtime).force(MANUAL_RETENTION_FAMILIES);
  return run;
}
export function retentionRun(db: Database, id: string) {
  const run = retentionStatus(db).run;
  if (run?.id !== id)
    throw new NotFoundError(
      'This bounded status slot no longer contains the requested run',
      'retention_run_not_found',
    );
  return run;
}

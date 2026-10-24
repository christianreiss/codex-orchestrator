import { persistAuditLog } from '../../services/audit-log.js';
import type { Json } from '../../control-plane/commands.js';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { hosts, type Host } from '../../db/schema.js';
import {
  mutateOwnerState,
  ownerRuntimeFor,
  withOwnerBackgroundScope,
  type OwnerRuntime,
} from '../../control-plane/state/runtime.js';
import { stageUpdate, stageDelete } from '../../control-plane/state/rows.js';
import { projectHostDeletion } from '../../control-plane/state/deletion.js';
import { suspendOwnedMessaging } from '../../control-plane/state/suspension.js';
import { hashApiKey } from '../../util/api-key-helpers.js';
import { UnauthorizedError } from '../../http/errors.js';
import { hostEnginesList, assertHostEngineAssigned } from '../../services/host-engine-policy.js';
import type { Engine } from '../../util/engine.js';
import { nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';

const pending = new WeakMap<OwnerRuntime, Map<number, number>>();
/** Approximate request telemetry; only dirty counters schedule one bounded flush. */
export async function recordAuthCall(db: Database, host: Host): Promise<number> {
  const owner = ownerRuntimeFor(db);
  if (!owner) {
    await db
      .update(hosts)
      .set({ apiCalls: sql`${hosts.apiCalls} + 1`, updatedAt: nowIso() })
      .where(eq(hosts.id, host.id));
    return Number(host.apiCalls ?? 0) + 1;
  }
  owner.assertOwner();
  let buffer = pending.get(owner);
  if (!buffer) {
    buffer = new Map();
    pending.set(owner, buffer);
  }
  const empty = buffer.size === 0,
    count = (buffer.get(host.id) ?? 0) + 1;
  buffer.set(host.id, count);
  if (empty) owner.deadlines.schedule('host-auth-usage', Date.now() + 30000, () => flushAuthCalls(owner));
  return Number(owner.state.snapshot().hosts.get(host.id)?.apiCalls ?? host.apiCalls ?? 0) + count;
}
export async function flushAuthCalls(owner: OwnerRuntime): Promise<void> {
  const buffer = pending.get(owner);
  if (!buffer?.size) return;
  const batch = new Map(buffer);
  buffer.clear();
  owner.deadlines.cancel('host-auth-usage');
  try {
    await withOwnerBackgroundScope(() =>
      mutateOwnerState(owner, {
        kind: 'host.auth_usage',
        principal: 'system:host-auth-usage',
        payload: { counts: [...batch].map(([id, count]) => ({ id, count })) },
        prepare: (c) => {
          for (const [id, count] of batch) {
            const row = c.draft.table('hosts').get(id);
            if (row) stageUpdate(c, 'hosts', id, { apiCalls: Number(row.apiCalls ?? 0) + count });
          }
          return null;
        },
      }),
    );
  } catch (error) {
    for (const [id, count] of batch) buffer.set(id, count + (buffer.get(id) ?? 0));
    owner.deadlines.schedule('host-auth-usage', Date.now() + 30000, () => flushAuthCalls(owner));
    throw error;
  }
}
export async function uninstallOwnedHost(
  owner: OwnerRuntime,
  host: Host,
  engine: Engine | undefined,
  force: boolean,
) {
  const result = await mutateOwnerState(owner, {
    kind: 'host.uninstall',
    responseAuthorization: 'commit',
    payload: { hostId: host.id, engine: engine ?? null, force },
    authorize: (s) => {
      const current = s.hosts.get(host.id);
      if (!current || current.credentialLookupHash !== hashApiKey(host.apiKey))
        throw new UnauthorizedError('Host key changed', 'invalid_api_key');
    },
    prepare: (c): Json => {
      const current = c.draft.table('hosts').get(host.id)!;
      if (engine) assertHostEngineAssigned(current, engine);
      const remaining = engine ? hostEnginesList(current.engines).filter((item) => item !== engine) : [],
        at = nowIso(),
        partial = !!engine && remaining.length > 0;
      suspendOwnedMessaging(
        c,
        host.id,
        partial ? 'engine_disabled' : 'host_inactive',
        partial ? [engine!] : undefined,
        at,
      );
      for (const table of ['installTokens', 'hostAuthDigests', 'hostAuthStates'] as const)
        for (const row of c.draft.table(table).by('hostId', host.id))
          if (!partial || row.engine === engine)
            stageDelete(c, table, JSON.parse(c.draft.table(table).keyFor(row)) as Array<string | number>);
      if (partial) {
        const patch =
          engine === 'grok'
            ? {
                grokAuthDigest: null,
                grokLastRefresh: null,
                grokClientVersion: null,
                grokClientVersionOverride: null,
                grokWrapperVersion: null,
                grokModelOverride: null,
                grokReasoningEffortOverride: null,
              }
            : engine === 'claude'
              ? {
                  claudeAuthDigest: null,
                  claudeLastRefresh: null,
                  claudeClientVersion: null,
                  claudeClientVersionOverride: null,
                  claudeWrapperVersion: null,
                  claudeModelOverride: null,
                  claudeReasoningEffortOverride: null,
                }
              : {
                  authDigest: null,
                  lastRefresh: null,
                  clientVersion: null,
                  clientVersionOverride: null,
                  wrapperVersion: null,
                  lanePreference: null,
                  modelOverride: null,
                  reasoningEffortOverride: null,
                };
        stageUpdate(c, 'hosts', host.id, { ...patch, engines: remaining.join(','), updatedAt: at });
      } else {
        projectHostDeletion(c.draft, host.id);
        stageDelete(c, 'hosts', host.id);
      }
      c.write(async (tx) => {
        await persistAuditLog(tx, {
          hostId: partial ? host.id : null,
          action: partial ? 'host.engine.delete' : 'host.delete',
          details: JSON.stringify({
            host_id: host.id,
            fqdn: current.fqdn,
            ...(partial ? { engine } : {}),
            initiator: 'host_api',
            force,
          }),
          createdAt: at,
        });
      });
      return partial ? { deleted_engine: engine!, remaining_engines: remaining } : { deleted: current.fqdn };
    },
  });
  wsPublisher.publish(
    engine && result && typeof result === 'object' && 'deleted_engine' in result
      ? 'host.updated'
      : 'host.deleted',
    { id: host.id, fqdn: host.fqdn, ...(engine ? { engine } : {}) },
  );
  return result;
}

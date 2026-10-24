import { persistAuditLog } from '../../services/audit-log.js';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { authEntries, engineDestroyHosts, versions } from '../../db/schema.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';
import { hostEnginesList } from '../../services/host-engine-policy.js';
import type { DestroyRequest, DestroyProgress, DestroyStatus } from '../../services/engine-destroy.js';
import { ENGINES, type Engine } from '../../util/engine.js';
import { type OwnerRuntime, mutateOwnerState, type OwnerMutationContext } from '../state/runtime.js';
import type { OwnerStateSnapshot } from '../state/store.js';
import { stageDelete, stageUpdate } from '../state/rows.js';
import { ownedEngineState } from '../state/messaging.js';

const flag = (engine: Engine) => `${engine}_engine_destroy`;
export function ownedDestroyRequests(snapshot: OwnerStateSnapshot): DestroyRequest[] {
  return ENGINES.flatMap((engine) => {
    const raw = snapshot.setting(flag(engine));
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as Partial<DestroyRequest>;
      return typeof v.request_id === 'string' && v.request_id
        ? [
            {
              engine,
              request_id: v.request_id,
              requested_at: typeof v.requested_at === 'string' ? v.requested_at : '',
              requested_by: typeof v.requested_by === 'string' ? v.requested_by : null,
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
}
export function ownedDestroyProgress(snapshot: OwnerStateSnapshot, engine: Engine): DestroyProgress {
  const request = ownedDestroyRequests(snapshot).find((r) => r.engine === engine) ?? null,
    counts: Record<DestroyStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  const hosts = request
    ? snapshot
        .table('engineDestroyHosts')
        .by('requestId', request.request_id)
        .flatMap((row) => {
          const host = snapshot.hosts.get(row.hostId);
          if (!host || host.internalRole !== null) return [];
          let residue: string[] = [];
          try {
            const parsed = JSON.parse(row.residueJson ?? '[]');
            if (Array.isArray(parsed)) residue = parsed.filter((v) => typeof v === 'string');
          } catch {
            /* Malformed historical residue has no display entries. */
          }
          if (row.status in counts) counts[row.status as DestroyStatus]++;
          return [
            { host_id: host.id, fqdn: host.fqdn, status: row.status, residue, reported_at: row.reportedAt },
          ];
        })
    : [];
  return { engine, request, counts, hosts };
}
function bumpHosts(c: OwnerMutationContext, now: string) {
  for (const host of c.draft.table('hosts').all())
    stageUpdate(c, 'hosts', host.id, { configVersion: host.configVersion + 1, updatedAt: now });
}
function audit(c: OwnerMutationContext, details: Record<string, unknown>, now: string) {
  c.write((tx) =>
    persistAuditLog(tx, {
      hostId: null,
      action: 'admin.engine.destroy',
      details: JSON.stringify(details),
      createdAt: now,
    }),
  );
}
export async function requestOwnedEngineDestroy(owner: OwnerRuntime, engine: Engine, actor: string | null) {
  return mutateOwnerState(owner, {
    kind: 'engine.destroy.request',
    responseAuthorization: 'commit',
    payload: { engine, actor },
    prepare(c) {
      if (ownedEngineState(c.snapshot)[engine])
        throw new ConflictError(
          `${engine} must be suspended before it can be destroyed`,
          'engine_not_suspended',
          { engine },
        );
      const now = new Date().toISOString(),
        existing = ownedDestroyRequests(c.snapshot).find((r) => r.engine === engine),
        request = existing ?? { engine, request_id: randomUUID(), requested_at: now, requested_by: actor };
      if (!existing) {
        const row = {
          name: flag(engine),
          version: JSON.stringify({ request_id: request.request_id, requested_at: now, requested_by: actor }),
          updatedAt: now,
        };
        c.draft.upsert('versions', row);
        c.write((tx) =>
          tx
            .insert(versions)
            .values(row)
            .onDuplicateKeyUpdate({ set: { version: row.version, updatedAt: now } }),
        );
      }
      const known = new Set(
        c.snapshot
          .table('engineDestroyHosts')
          .by('requestId', request.request_id)
          .map((row) => row.hostId),
      );
      const fresh = c.snapshot.hosts
        .all()
        .filter((host) => hostEnginesList(host.engines).includes(engine) && !known.has(host.id));
      for (const host of fresh) {
        const row = {
          requestId: request.request_id,
          hostId: host.id,
          engine,
          status: 'pending',
          residueJson: null,
          reportedAt: null,
          createdAt: now,
        };
        c.draft.upsert('engineDestroyHosts', row);
        c.write((tx) => tx.insert(engineDestroyHosts).values(row));
      }
      if (fresh.length || !existing) bumpHosts(c, now);
      if (!existing)
        audit(c, { engine, op: 'request', request_id: request.request_id, actor, hosts: fresh.length }, now);
      return {
        request: { ...request },
        hosts_targeted: known.size + fresh.length,
        already_open: Boolean(existing),
      };
    },
  });
}
export async function cancelOwnedEngineDestroy(owner: OwnerRuntime, engine: Engine, actor: string | null) {
  return mutateOwnerState(owner, {
    kind: 'engine.destroy.cancel',
    payload: { engine, actor },
    prepare(c) {
      const request = ownedDestroyRequests(c.snapshot).find((r) => r.engine === engine);
      if (!request) return { cancelled: false };
      const now = new Date().toISOString();
      stageDelete(c, 'versions', flag(engine));
      for (const row of c.snapshot.table('engineDestroyHosts').by('requestId', request.request_id))
        stageDelete(c, 'engineDestroyHosts', [row.requestId, row.hostId]);
      bumpHosts(c, now);
      audit(c, { engine, op: 'cancel', request_id: request.request_id, actor }, now);
      return { cancelled: true };
    },
  });
}
export async function recordOwnedDestroyReport(
  owner: OwnerRuntime,
  hostId: number,
  input: { engine: Engine; request_id: string; status: string },
  residue: string[],
) {
  return mutateOwnerState(owner, {
    kind: 'engine.destroy.report',
    payload: { hostId, ...input, residue },
    prepare(c) {
      const request = ownedDestroyRequests(c.snapshot).find((r) => r.engine === input.engine);
      if (!request || request.request_id !== input.request_id) return { recorded: false };
      const row = c.snapshot.table('engineDestroyHosts').get([input.request_id, hostId]);
      if (row)
        stageUpdate(c, 'engineDestroyHosts', [input.request_id, hostId], {
          status: input.status,
          residueJson: JSON.stringify(residue),
          reportedAt: new Date().toISOString(),
        });
      return { recorded: true };
    },
  });
}
export async function purgeOwnedEngine(
  owner: OwnerRuntime,
  engine: Engine,
  options: { force: boolean; actor: string | null },
) {
  return mutateOwnerState(owner, {
    kind: 'engine.destroy.purge',
    responseAuthorization: 'commit',
    payload: { engine, ...options },
    prepare(c) {
      const progress = ownedDestroyProgress(c.snapshot, engine);
      if (!progress.request) throw new NotFoundError('No destroy request is open for this engine');
      const unfinished = progress.counts.pending + progress.counts.running + progress.counts.failed;
      if (unfinished && !options.force)
        throw new ConflictError(
          `${unfinished} host(s) have not completed the destroy`,
          'engine_destroy_incomplete',
          { engine, counts: progress.counts },
        );
      const now = new Date().toISOString(),
        payloads = c.snapshot
          .table('authPayloads')
          .all()
          .filter((row) => row.engine === engine),
        accounts = c.snapshot.accounts.all().filter((row) => row.engine === engine);
      for (let offset = 0; offset < payloads.length; offset += 500) {
        const ids = payloads.slice(offset, offset + 500).map((row) => row.id);
        c.write((tx) => tx.delete(authEntries).where(inArray(authEntries.payloadId, ids)));
      }
      stageDelete(c, 'authCanonicalHeads', engine);
      for (const row of payloads) stageDelete(c, 'authPayloads', row.id);
      for (const row of c.snapshot.table('providerAccountSessions').all())
        if (row.engine === engine) stageDelete(c, 'providerAccountSessions', row.id);
      for (const row of accounts) {
        stageDelete(c, 'grokAuthRefreshState', row.id);
        stageDelete(c, 'providerAccounts', row.id);
      }
      for (const name of ['authSeedTokens', 'hostAuthDigests', 'installTokens'] as const)
        for (const row of c.snapshot.table(name).all())
          if (row.engine === engine) stageDelete(c, name, row.id);
      for (const row of c.snapshot.table('hostAuthStates').all())
        if (row.engine === engine) stageDelete(c, 'hostAuthStates', [row.hostId, row.engine]);
      let unassigned = 0;
      for (const host of c.snapshot.hosts.all()) {
        const list = hostEnginesList(host.engines),
          remaining = list.filter((e) => e !== engine);
        if (list.includes(engine) && remaining.length) {
          stageUpdate(c, 'hosts', host.id, {
            engines: remaining.join(','),
            configVersion: host.configVersion + 1,
            updatedAt: now,
          });
          unassigned++;
        }
      }
      audit(
        c,
        {
          engine,
          op: 'purge',
          request_id: progress.request.request_id,
          actor: options.actor,
          force: options.force,
          payloads: payloads.length,
          accounts: accounts.length,
          hosts_unassigned: unassigned,
        },
        now,
      );
      return {
        purged: true,
        payloads: payloads.length,
        accounts: accounts.length,
        hosts_unassigned: unassigned,
      };
    },
  });
}

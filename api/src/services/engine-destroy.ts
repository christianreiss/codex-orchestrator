/**
 * Fleet-wide "destroy engine".
 *
 * Suspending an engine (`engine-switch.ts`) keeps everything. Destroying it
 * asks every host that carries the engine to remove it completely — signed
 * config, binaries, shims, aliases, homes and credentials — and to report back.
 * The server side is a request flag plus one progress row per host:
 *
 *   - `versions` row `<engine>_engine_destroy` holds the request (JSON).
 *   - `engine_destroy_hosts` holds per-host status (`pending|running|done|failed`).
 *   - The signed wrapper config carries `host.destroy_engines` while a request
 *     exists, so a host acts on its next sync; the wrapper is idempotent and
 *     remembers the request id it already completed.
 *   - `purgeEngineServerData` is a separate, later step: it drops the engine's
 *     stored credentials and accounts and unassigns it from hosts.
 *
 * A request needs the engine to be suspended first, and re-enabling is refused
 * until the request is cancelled or the engine's data is gone.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  authCanonicalHeads,
  authEntries,
  authPayloads,
  authSeedTokens,
  engineDestroyHosts,
  hostAuthDigests,
  hostAuthStates,
  hosts,
  installTokens,
  logs,
  providerAccountSessions,
  providerAccounts,
  versions,
} from '../db/schema.js';
import { wsPublisher } from '../ws/publisher.js';
import { nowIso } from '../util/timestamp.js';
import { ENGINES, type Engine } from '../util/engine.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { hostEnginesList } from './host-engine-policy.js';
import { readFleetEngineState } from './engine-switch.js';

export const ENGINE_DESTROY_FLAGS: Readonly<Record<Engine, string>> = Object.freeze({
  codex: 'codex_engine_destroy',
  claude: 'claude_engine_destroy',
  grok: 'grok_engine_destroy',
});
export const ENGINE_DESTROY_AUDIT_ACTION = 'admin.engine.destroy';
export const DESTROY_STATUSES = ['running', 'done', 'failed'] as const;
export type DestroyStatus = 'pending' | (typeof DESTROY_STATUSES)[number];

export interface DestroyRequest {
  engine: Engine;
  request_id: string;
  requested_at: string;
  requested_by: string | null;
}

function parseRequest(engine: Engine, raw: string | null | undefined): DestroyRequest | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DestroyRequest>;
    if (typeof v.request_id !== 'string' || !v.request_id) return null;
    return {
      engine,
      request_id: v.request_id,
      requested_at: typeof v.requested_at === 'string' ? v.requested_at : '',
      requested_by: typeof v.requested_by === 'string' ? v.requested_by : null,
    };
  } catch {
    return null;
  }
}

/** Open destroy requests, one per engine at most. */
export async function readDestroyRequests(db: Pick<Database, 'select'>): Promise<DestroyRequest[]> {
  const rows = await db
    .select({ name: versions.name, version: versions.version })
    .from(versions)
    .where(inArray(versions.name, ENGINES.map((e) => ENGINE_DESTROY_FLAGS[e])));
  const byName = new Map(rows.map((r) => [r.name, r.version]));
  const out: DestroyRequest[] = [];
  for (const engine of ENGINES) {
    const req = parseRequest(engine, byName.get(ENGINE_DESTROY_FLAGS[engine]));
    if (req) out.push(req);
  }
  return out;
}

export async function readDestroyRequest(db: Pick<Database, 'select'>, engine: Engine): Promise<DestroyRequest | null> {
  return (await readDestroyRequests(db)).find((r) => r.engine === engine) ?? null;
}

/** Refuse to re-enable an engine while a destroy request is open. */
export async function assertNoDestroyRequest(db: Pick<Database, 'select'>, engine: Engine): Promise<void> {
  if (await readDestroyRequest(db, engine)) {
    throw new ConflictError(`${engine} has an open destroy request; cancel it before re-enabling`, 'engine_destroy_open', { engine });
  }
}

/**
 * The `{engine, request_id}` pairs a host must act on: open requests for which
 * the host has a progress row. Hosts without a row never carried the engine.
 */
export async function destroyDirectivesForHost(
  db: Pick<Database, 'select'>,
  hostId: number,
): Promise<Array<{ engine: Engine; request_id: string }>> {
  try {
    const requests = await readDestroyRequests(db);
    if (requests.length === 0) return [];
    const rows = await db
      .select({ requestId: engineDestroyHosts.requestId })
      .from(engineDestroyHosts)
      .where(and(eq(engineDestroyHosts.hostId, hostId), inArray(engineDestroyHosts.requestId, requests.map((r) => r.request_id))));
    const mine = new Set(rows.map((r) => r.requestId));
    return requests.filter((r) => mine.has(r.request_id)).map((r) => ({ engine: r.engine, request_id: r.request_id }));
  } catch {
    // Config baking must not fail because the destroy tables are unreadable;
    // the directive is simply absent until the next bake.
    return [];
  }
}

export interface DestroyRequestResult {
  request: DestroyRequest;
  hosts_targeted: number;
  already_open: boolean;
}

/**
 * Open a destroy request. The engine must be suspended and `confirm` must
 * equal the engine name. Idempotent: an open request is returned unchanged;
 * hosts that gained the engine since are added to it.
 */
export async function requestEngineDestroy(
  db: Database,
  engine: Engine,
  confirm: unknown,
  actor: string | null,
): Promise<DestroyRequestResult> {
  if (confirm !== engine) throw new ValidationError(`confirm must equal "${engine}"`, { param: 'confirm' });
  if ((await readFleetEngineState(db, { fresh: true }))[engine]) {
    throw new ConflictError(`${engine} must be suspended (master switch off) before it can be destroyed`, 'engine_not_suspended', { engine });
  }
  const flag = ENGINE_DESTROY_FLAGS[engine];
  const now = nowIso();
  const result = await db.transaction(async (tx) => {
    const rows = await tx.select({ version: versions.version }).from(versions).where(eq(versions.name, flag)).limit(1).for('update');
    let request = parseRequest(engine, rows[0]?.version);
    const alreadyOpen = request !== null;
    if (!request) {
      request = { engine, request_id: randomUUID(), requested_at: now, requested_by: actor };
      const value = JSON.stringify({ request_id: request.request_id, requested_at: now, requested_by: actor });
      if (rows.length === 0) await tx.insert(versions).values({ name: flag, version: value, updatedAt: now });
      else await tx.update(versions).set({ version: value, updatedAt: now }).where(eq(versions.name, flag));
    }
    const carrying = (await tx.select({ id: hosts.id, engines: hosts.engines }).from(hosts)).filter((h) =>
      hostEnginesList(h.engines).includes(engine),
    );
    const known = new Set(
      (await tx.select({ hostId: engineDestroyHosts.hostId }).from(engineDestroyHosts).where(eq(engineDestroyHosts.requestId, request.request_id))).map((r) => r.hostId),
    );
    const fresh = carrying.filter((h) => !known.has(h.id));
    if (fresh.length) {
      await tx.insert(engineDestroyHosts).values(
        fresh.map((h) => ({ requestId: request!.request_id, hostId: h.id, engine, status: 'pending', createdAt: now })),
      );
    }
    if (fresh.length || !alreadyOpen) {
      await tx.update(hosts).set({ configVersion: sql`${hosts.configVersion} + 1`, updatedAt: now });
    }
    if (!alreadyOpen) {
      await tx.insert(logs).values({
        hostId: null,
        action: ENGINE_DESTROY_AUDIT_ACTION,
        details: JSON.stringify({ engine, op: 'request', request_id: request.request_id, actor, hosts: fresh.length }),
        createdAt: now,
      });
    }
    return { request, targeted: known.size + fresh.length, alreadyOpen };
  });
  wsPublisher.publish('engine.state.changed', { engine });
  return { request: result.request, hosts_targeted: result.targeted, already_open: result.alreadyOpen };
}

/** Withdraw a request. Hosts that already completed it stay destroyed. */
export async function cancelEngineDestroy(db: Database, engine: Engine, actor: string | null): Promise<{ cancelled: boolean }> {
  const flag = ENGINE_DESTROY_FLAGS[engine];
  const now = nowIso();
  const cancelled = await db.transaction(async (tx) => {
    const rows = await tx.select({ version: versions.version }).from(versions).where(eq(versions.name, flag)).limit(1).for('update');
    const request = parseRequest(engine, rows[0]?.version);
    if (!request) return false;
    await tx.delete(versions).where(eq(versions.name, flag));
    await tx.delete(engineDestroyHosts).where(eq(engineDestroyHosts.requestId, request.request_id));
    await tx.update(hosts).set({ configVersion: sql`${hosts.configVersion} + 1`, updatedAt: now });
    await tx.insert(logs).values({
      hostId: null,
      action: ENGINE_DESTROY_AUDIT_ACTION,
      details: JSON.stringify({ engine, op: 'cancel', request_id: request.request_id, actor }),
      createdAt: now,
    });
    return true;
  });
  if (cancelled) wsPublisher.publish('engine.state.changed', { engine });
  return { cancelled };
}

/** Host report. Unknown request ids (cancelled meanwhile) are ignored. */
export async function recordHostReport(
  db: Database,
  hostId: number,
  input: { engine: Engine; request_id: string; status: string; residue?: unknown },
): Promise<{ recorded: boolean }> {
  if (!(DESTROY_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError('status must be running, done or failed', { param: 'status' });
  }
  const residue = Array.isArray(input.residue)
    ? input.residue.filter((x): x is string => typeof x === 'string').slice(0, 50).map((x) => x.slice(0, 300))
    : [];
  const open = await readDestroyRequest(db, input.engine);
  if (!open || open.request_id !== input.request_id) return { recorded: false };
  const res = await db
    .update(engineDestroyHosts)
    .set({ status: input.status, residueJson: JSON.stringify(residue), reportedAt: nowIso() })
    .where(and(eq(engineDestroyHosts.requestId, input.request_id), eq(engineDestroyHosts.hostId, hostId)));
  void res;
  wsPublisher.publish('engine.state.changed', { engine: input.engine });
  return { recorded: true };
}

export interface DestroyProgress {
  engine: Engine;
  request: DestroyRequest | null;
  counts: Record<DestroyStatus, number>;
  hosts: Array<{ host_id: number; fqdn: string; status: string; residue: string[]; reported_at: string | null }>;
}

export async function listDestroyProgress(db: Database, engine: Engine): Promise<DestroyProgress> {
  const request = await readDestroyRequest(db, engine);
  const counts: Record<DestroyStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  if (!request) return { engine, request: null, counts, hosts: [] };
  const rows = await db
    .select({
      hostId: engineDestroyHosts.hostId,
      fqdn: hosts.fqdn,
      status: engineDestroyHosts.status,
      residueJson: engineDestroyHosts.residueJson,
      reportedAt: engineDestroyHosts.reportedAt,
    })
    .from(engineDestroyHosts)
    .innerJoin(hosts, eq(hosts.id, engineDestroyHosts.hostId))
    .where(eq(engineDestroyHosts.requestId, request.request_id));
  const list = rows.map((r) => {
    let residue: string[] = [];
    try {
      const p = JSON.parse(r.residueJson ?? '[]');
      if (Array.isArray(p)) residue = p.filter((x): x is string => typeof x === 'string');
    } catch { /* residue is advisory */ }
    if (r.status in counts) counts[r.status as DestroyStatus] += 1;
    return { host_id: r.hostId, fqdn: r.fqdn, status: r.status, residue, reported_at: r.reportedAt };
  });
  return { engine, request, counts, hosts: list };
}

/**
 * Drop the engine's server-side data and unassign it from every host. Refused
 * while hosts are still pending/running/failed unless `force`.
 */
export async function purgeEngineServerData(
  db: Database,
  engine: Engine,
  options: { force: boolean; actor: string | null },
): Promise<{ purged: true; payloads: number; accounts: number; hosts_unassigned: number }> {
  const progress = await listDestroyProgress(db, engine);
  if (!progress.request) throw new NotFoundError('No destroy request is open for this engine');
  const unfinished = progress.counts.pending + progress.counts.running + progress.counts.failed;
  if (unfinished > 0 && !options.force) {
    throw new ConflictError(`${unfinished} host(s) have not completed the destroy; wait or pass force`, 'engine_destroy_incomplete', {
      engine,
      counts: progress.counts,
    });
  }
  const now = nowIso();
  const out = await db.transaction(async (tx) => {
    const payloadIds = (await tx.select({ id: authPayloads.id }).from(authPayloads).where(eq(authPayloads.engine, engine))).map((r) => r.id);
    for (let i = 0; i < payloadIds.length; i += 500) {
      await tx.delete(authEntries).where(inArray(authEntries.payloadId, payloadIds.slice(i, i + 500)));
    }
    await tx.delete(authCanonicalHeads).where(eq(authCanonicalHeads.engine, engine));
    await tx.delete(authPayloads).where(eq(authPayloads.engine, engine));
    const accounts = await tx.select({ id: providerAccounts.id }).from(providerAccounts).where(eq(providerAccounts.engine, engine));
    await tx.delete(providerAccountSessions).where(eq(providerAccountSessions.engine, engine));
    await tx.delete(providerAccounts).where(eq(providerAccounts.engine, engine));
    await tx.delete(authSeedTokens).where(eq(authSeedTokens.engine, engine));
    await tx.delete(hostAuthDigests).where(eq(hostAuthDigests.engine, engine));
    await tx.delete(hostAuthStates).where(eq(hostAuthStates.engine, engine));
    await tx.delete(installTokens).where(eq(installTokens.engine, engine));
    let unassigned = 0;
    for (const h of await tx.select({ id: hosts.id, engines: hosts.engines }).from(hosts)) {
      const list = hostEnginesList(h.engines);
      if (!list.includes(engine)) continue;
      const remaining = list.filter((e) => e !== engine);
      // A host whose only engine was destroyed keeps its assignment: an empty
      // column would silently read back as Codex.
      if (remaining.length === 0) continue;
      await tx.update(hosts).set({ engines: remaining.join(','), configVersion: sql`${hosts.configVersion} + 1`, updatedAt: now }).where(eq(hosts.id, h.id));
      unassigned += 1;
    }
    await tx.insert(logs).values({
      hostId: null,
      action: ENGINE_DESTROY_AUDIT_ACTION,
      details: JSON.stringify({ engine, op: 'purge', request_id: progress.request!.request_id, actor: options.actor, force: options.force, payloads: payloadIds.length, accounts: accounts.length, hosts_unassigned: unassigned }),
      createdAt: now,
    });
    return { payloads: payloadIds.length, accounts: accounts.length, unassigned };
  });
  wsPublisher.publish('engine.state.changed', { engine });
  return { purged: true, payloads: out.payloads, accounts: out.accounts, hosts_unassigned: out.unassigned };
}

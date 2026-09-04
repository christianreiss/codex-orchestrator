/**
 * What a live agent session is working on, as distinct from whether it is alive.
 *
 * `AgentPortalService.listAgents()` answers liveness — heartbeat, derived
 * presence, whether a turn is running. It cannot answer "on what": the session
 * row knows a working directory and nothing else. Two other tables do, and both
 * are joined here rather than inside the portal service so the enrichment stays
 * strictly additive. A null result means the agent declared nothing, never that
 * the read failed.
 *
 * The Git Director join is by path, because a path is the only identity a
 * worktree registration has — `git_worktrees.worktree_hash` is sha256 of the
 * normalized worktree path, and every agent on a host shares one API key, so the
 * credential cannot tell two worktrees apart. Matching the session's `cwd`
 * alone would miss most of the fleet, because an agent routinely works from a
 * directory *below* the worktree it registered. Every ancestor of the cwd is
 * hashed instead and the deepest match wins, which is the same containment rule
 * `overlappingPaths` already applies when arbitrating a merge.
 *
 * The Agent Messaging join needs none of that. `agent_bus_addresses`
 * `current_session_id` points straight at the session and
 * `uq_agent_bus_addresses_session` makes it unique, so a live address resolves
 * exactly — and a session that has ended has none, which is correct rather than
 * a gap: `finishSession` nulls the pointer.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentBusAddresses, gitWorktrees } from '../db/schema.js';
import { normalizePath, sha256 } from './git-director.js';

export interface SessionWork {
  /** Free text the agent declared through `git_join`. */
  task: string | null;
  branch: string | null;
  target_branch: string | null;
  declared_paths: string[];
  /**
   * The registered worktree the cwd resolved into. Worth showing when it is not
   * the cwd itself, because that is the case where the task text belongs to a
   * directory above the one the agent is sitting in.
   */
  worktree_path: string | null;
  /** How a peer would reach this agent over Agent Messaging. */
  address: string | null;
  address_alias: string | null;
}

/** The fields of a listed session this module reads. */
export interface SessionWorkInput {
  id: string;
  host_id: number;
  cwd: string;
}

const EMPTY: SessionWork = {
  task: null,
  branch: null,
  target_branch: null,
  declared_paths: [],
  worktree_path: null,
  address: null,
  address_alias: null,
};

/**
 * A path and every directory above it, deepest first, stopping short of the
 * filesystem root — a worktree registered at `/` would otherwise claim every
 * session on the host.
 */
export function pathLineage(raw: string): string[] {
  const normalized = normalizePath(raw);
  if (!normalized) return [];
  if (!normalized.startsWith('/')) return [normalized];
  const out: string[] = [];
  let cursor = normalized;
  while (cursor.length > 1) {
    out.push(cursor);
    const cut = cursor.lastIndexOf('/');
    if (cut <= 0) break;
    cursor = cursor.slice(0, cut);
  }
  return out;
}

function asPaths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Resolves the work context for a page of sessions in two queries, keyed by
 * session id. Sessions with nothing declared are simply absent from the map;
 * callers should fall back to {@link emptyWork}.
 */
export async function loadSessionWork(
  db: Database,
  sessions: readonly SessionWorkInput[],
): Promise<Map<string, SessionWork>> {
  const resolved = new Map<string, SessionWork>();
  if (sessions.length === 0) return resolved;

  const lineages = new Map<string, string[]>();
  const hashes = new Set<string>();
  for (const session of sessions) {
    const lineage = pathLineage(session.cwd);
    lineages.set(session.id, lineage);
    for (const path of lineage) hashes.add(sha256(path));
  }

  const worktrees = hashes.size
    ? await db
        .select({
          hostId: gitWorktrees.hostId,
          worktreeHash: gitWorktrees.worktreeHash,
          worktreePath: gitWorktrees.worktreePath,
          task: gitWorktrees.task,
          branch: gitWorktrees.branch,
          targetBranch: gitWorktrees.targetBranch,
          declaredPaths: gitWorktrees.declaredPaths,
        })
        .from(gitWorktrees)
        .where(and(eq(gitWorktrees.status, 'active'), inArray(gitWorktrees.worktreeHash, [...hashes])))
    : [];

  // Hash alone is not an identity: two hosts can register the same path.
  const byHostHash = new Map<string, (typeof worktrees)[number]>();
  for (const row of worktrees) byHostHash.set(`${row.hostId}:${row.worktreeHash}`, row);

  const sessionIds = sessions.map((session) => session.id);
  const addresses = await db
    .select({
      sessionId: agentBusAddresses.currentSessionId,
      address: agentBusAddresses.address,
      displayAlias: agentBusAddresses.displayAlias,
    })
    .from(agentBusAddresses)
    .where(inArray(agentBusAddresses.currentSessionId, sessionIds));
  const addressBySession = new Map(
    addresses.flatMap((row) => (row.sessionId ? [[row.sessionId, row] as const] : [])),
  );

  for (const session of sessions) {
    const lineage = lineages.get(session.id) ?? [];
    let worktree: (typeof worktrees)[number] | undefined;
    for (const path of lineage) {
      worktree = byHostHash.get(`${session.host_id}:${sha256(path)}`);
      if (worktree) break;
    }
    const address = addressBySession.get(session.id);
    if (!worktree && !address) continue;
    resolved.set(session.id, {
      task: worktree?.task ?? null,
      branch: worktree?.branch ?? null,
      target_branch: worktree?.targetBranch ?? null,
      declared_paths: asPaths(worktree?.declaredPaths),
      worktree_path: worktree?.worktreePath ?? null,
      address: address?.address ?? null,
      address_alias: address?.displayAlias ?? null,
    });
  }
  return resolved;
}

export function emptyWork(): SessionWork {
  return { ...EMPTY, declared_paths: [] };
}

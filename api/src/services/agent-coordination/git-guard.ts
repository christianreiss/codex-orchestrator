import { eq, inArray } from 'drizzle-orm';
import { posix } from 'node:path';
import {
  agentResourceClaims,
  agentSessions,
  versions,
  type GitClone,
  type GitWorktree,
} from '../../db/schema.js';
import { ConflictError } from '../../http/errors.js';
import type { AgentMessagingDb } from '../agent-messaging/types.js';
import { overlaps, type Resource } from './model.js';

/** Same ordering as scope transactions: bus gate before clone/worktree rows. */
export async function lockClaimGate(tx: AgentMessagingDb) {
  await tx
    .select({ version: versions.version })
    .from(versions)
    .where(eq(versions.name, 'agent_messaging_enabled'))
    .limit(1)
    .for('update');
}

export async function guardGitMutation(
  tx: AgentMessagingDb,
  clone: GitClone,
  worktree: GitWorktree,
  branch: string,
  paths: string[],
) {
  const [flag] = await tx.select().from(versions).where(eq(versions.name, 'agent_coordination_enabled'));
  const held = await tx
    .select()
    .from(agentResourceClaims)
    .where(inArray(agentResourceClaims.state, ['active', 'uncertain']));
  if (flag?.version !== '1' && held.length === 0) return;
  const sessions = worktree.agentBusAddressId
    ? await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.agentBusAddressId, worktree.agentBusAddressId))
    : [];
  const session = sessions.find(
    (s) =>
      !s.endedAt && (s.adapterCapabilities as Record<string, unknown> | null)?.scope_protocol_version === 1,
  );
  const resources: Resource[] = [
    { kind: 'git', host_id: clone.hostId, common_dir: clone.cloneDir, branch },
    ...(paths.length ? paths : ['.']).map((path) => ({
      kind: 'path' as const,
      host_id: clone.hostId,
      path: posix.resolve(worktree.worktreePath, path),
    })),
  ];
  const conflicts = held.filter(
    (c) =>
      (!session ||
        c.sessionId !== session.id ||
        c.generation !== session.bindingGeneration ||
        c.state === 'uncertain' ||
        Date.parse(c.expiresAt) <= Date.now()) &&
      (c.resources as Resource[]).some((a) => resources.some((b) => overlaps(a, b))),
  );
  // Without a live protocol-1 session the guard cannot attribute any claim, so
  // the requester's own live claims count against it. Still block (an unbound
  // registration must never pass a foreign reservation), but name the binding
  // as the actionable condition. Only the message reaches MCP callers.
  if (conflicts.length && !session && conflicts.every((c) => c.state === 'active' && Date.parse(c.expiresAt) > Date.now()))
    throw new ConflictError(
      (worktree.agentBusAddressId
        ? 'This worktree registration is bound to an agent session that is no longer live (or lacks scope protocol 1)'
        : 'This worktree registration is not bound to a live agent session (agent_address_bound=false)') +
        ', so the overlapping resource claims cannot be attributed to you. Re-register this worktree_path with ' +
        'git_register passing username, engine and the current head_sha (run agent_context_update with this ' +
        'worktree as cwd/git_root first if your session started elsewhere), confirm agent_address_bound=true, then ' +
        'retry the same client_request_id. If it stays blocked after binding, the claims belong to another owner.',
      'resource_claim_conflict',
      {
        claim_ids: conflicts.map((c) => c.id),
        reason: worktree.agentBusAddressId ? 'registration_session_unavailable' : 'registration_unbound',
        agent_address_bound: Boolean(worktree.agentBusAddressId),
      },
    );
  if (conflicts.length)
    throw new ConflictError(
      'Resources are reserved or uncertain; coordinate with owners before merging',
      'resource_claim_conflict',
      { claim_ids: conflicts.map((c) => c.id) },
    );
  if (flag?.version === '1' && session) {
    const own = held
      .filter(
        (c) =>
          c.sessionId === session.id &&
          c.generation === session.bindingGeneration &&
          c.state === 'active' &&
          Date.parse(c.expiresAt) > Date.now(),
      )
      .flatMap((c) => c.resources as Resource[]);
    const covered = resources.every((r) =>
      own.some((a) => {
        if (!overlaps(a, r)) return false;
        if (a.kind === 'path' && r.kind === 'path')
          return r.path === a.path || r.path.startsWith(a.path === '/' ? '/' : a.path + '/');
        return true;
      }),
    );
    if (!covered)
      throw new ConflictError(
        'Acquire live path and target-branch claims before requesting this merge',
        'resource_claim_required',
      );
  }
}

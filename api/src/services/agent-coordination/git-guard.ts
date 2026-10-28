import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { claimContinuouslyHeld } from '../../control-plane/state/resource-claims.js';
import { coordinationPresent } from '../../control-plane/state/coordination.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
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
import { CLAIM_RECOVERY_GUIDANCE } from './recovery-guidance.js';

/** Same ordering as scope transactions: bus gate before clone/worktree rows. */
export async function lockClaimGate(tx: AgentMessagingDb) {
  const owner=ownerRuntimeFor(tx);if(owner){owner.assertOwner();return;}
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
  composed?: OwnerStateSnapshot,
) {
  const owner=ownerRuntimeFor(tx),snapshot=owner?(composed??owner.state.snapshot()):undefined;
  owner?.assertOwner();
  const flag=snapshot?snapshot.settings.get('agent_coordination_enabled'):(await tx.select().from(versions).where(eq(versions.name,'agent_coordination_enabled')))[0];
  const held = snapshot?snapshot.claims.all().filter(row=>['active','uncertain'].includes(row.state)):await tx
    .select()
    .from(agentResourceClaims)
    .where(inArray(agentResourceClaims.state, ['active', 'uncertain']));
  if (flag?.version !== '1' && held.length === 0 && !worktree.agentSessionId) return;
  const sessions = worktree.agentBusAddressId
    ? snapshot?snapshot.sessions.by('agentBusAddressId',worktree.agentBusAddressId):await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.agentBusAddressId, worktree.agentBusAddressId))
    : [];
  const session = sessions.find(
    (s) =>
      !s.endedAt && (!owner || coordinationPresent(owner,s)) && (!worktree.agentSessionId || s.id === worktree.agentSessionId && s.bindingGeneration === worktree.agentBindingGeneration) && (s.adapterCapabilities as Record<string, unknown> | null)?.scope_protocol_version === 1,
  );
  const remoteBinding = sessions.find((s) => s.id === worktree.agentSessionId && s.hostId !== clone.hostId);
  if (remoteBinding && !session)
    throw new ConflictError('Registered session binding is no longer live; re-register from the current managed launch', 'git_remote_binding_stale');
  const resources: Resource[] = [
    { kind: 'git', host_id: clone.hostId, common_dir: clone.cloneDir, branch },
    ...(paths.length ? paths : ['.']).map((path) => ({
      kind: 'path' as const,
      host_id: clone.hostId,
      path: posix.resolve(worktree.worktreePath, path),
    })),
  ];
  const liveClaim=(claim: typeof held[number])=>owner&&snapshot?claimContinuouslyHeld(owner,snapshot,claim):Date.parse(claim.expiresAt)>Date.now();
  const conflicts = held.filter(
    (c) =>
      (!session ||
        c.sessionId !== session.id ||
        c.generation !== session.bindingGeneration ||
        c.state === 'uncertain' ||
        !liveClaim(c)) &&
      (c.resources as Resource[]).some((a) => resources.some((b) => overlaps(a, b))),
  );
  // Without a live protocol-1 session the guard cannot attribute any claim, so
  // the requester's own live claims count against it. Still block (an unbound
  // registration must never pass a foreign reservation), but name the binding
  // as the actionable condition. Only the message reaches MCP callers.
  if (conflicts.length && !session && conflicts.every((c) => c.state === 'active' && liveClaim(c)))
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
      'Resources are reserved or uncertain; coordinate with owners before merging: ' +
        conflicts.map((c) => `${c.id} session=${c.sessionId} state=${c.state} purpose=${c.purpose}`).join('; ') +
        '.' + CLAIM_RECOVERY_GUIDANCE,
      'resource_claim_conflict',
      { claim_ids: conflicts.map((c) => c.id), blockers: conflicts.map((c) => ({
        id: c.id, session_id: c.sessionId, state: c.state, uncertainty_reason: c.uncertaintyReason ?? null, purpose: c.purpose, resources: c.resources,
      })), recovery_path: '/admin/agent-messaging/scopes/resolve',
      // Connection-loss claims release themselves once their owner stays offline;
      // only an outcome the owner reported as unknown needs an operator.
      operator_required: conflicts.some((c) => c.state === 'uncertain' && c.uncertaintyReason === 'reported_unknown') },
    );
  if (session && (flag?.version === '1' || session.hostId !== clone.hostId)) {
    const own = held
      .filter(
        (c) =>
          c.sessionId === session.id &&
          c.generation === session.bindingGeneration &&
          c.state === 'active' &&
          liveClaim(c),
      )
      .flatMap((c) => c.resources as Resource[]);
    const isCovered = (r: Resource) =>
      own.some((a) => {
        if (!overlaps(a, r)) return false;
        if (a.kind === 'path' && r.kind === 'path')
          return r.path === a.path || r.path.startsWith(a.path === '/' ? '/' : a.path + '/');
        return true;
      });
    const missing = resources.filter((r) => !isCovered(r));
    if (missing.length)
      throw new ConflictError(
        'Acquire live path and target-branch claims before requesting this merge. Missing: ' +
          missing
            .map((r) => (r.kind === 'git' ? `git common_dir=${r.common_dir} branch=${r.branch}` : r.kind === 'path' ? `path ${r.path}` : r.kind))
            .join('; ') +
          `. The git claim must use this registration's clone_dir (${clone.cloneDir}); if your claim names the real ` +
          '`git rev-parse --git-common-dir` (usually <toplevel>/.git), re-register the worktree with that clone_dir.',
        'resource_claim_required',
        { missing, registered_clone_dir: clone.cloneDir },
      );
  }
}

import { legacyDrainFor } from '../legacy-drain.js';
import { ownerPresence } from '../presence.js';
import type { OwnerRuntime, OwnerMutationContext } from './runtime.js';
import type { OwnerStateSnapshot } from './store.js';
import type { StateRow } from './catalog.js';
import type { Keyring } from '../../security/keyring.js';
import { ownedMessagingHost, ownedEngineState } from './messaging.js';
import { activeHostEngines } from '../../services/host-engine-policy.js';
import type { Engine } from '../../util/engine.js';
import { stageUpdate } from './rows.js';
import { adminAudit } from './admin.js';
import { holderReleasable, OWNER_RECONNECT_GRACE_MS } from './owner-liveness.js';
import {
  stageScopeEvent,
  coordinationPresent,
  coordinationProtocol,
  type ScopeSession,
} from './coordination.js';
import { overlaps, NEGOTIATION_SECONDS, type Resource } from '../../services/agent-coordination/model.js';
import { readWorkspace } from '../../services/agent-messaging/workspace.js';

export type OwnedResourceClaim = Readonly<StateRow<'agentResourceClaims'>>;
export function nativeClaimAttachment(
  owner: OwnerRuntime,
  session: ScopeSession,
  nativeInstanceId?: string | null,
) {
  return ownerPresence(owner)
    .session(session.id, session.bindingGeneration, 'session')
    .find(
      (attachment) =>
        attachment.scope.native_instance_id &&
        (!nativeInstanceId || attachment.scope.native_instance_id === nativeInstanceId),
    );
}
export function claimContinuouslyHeld(
  owner: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  claim: OwnedResourceClaim,
): boolean {
  const session = snapshot.sessions.get(claim.sessionId);
  if (!session) return false;
  try {
    const host = ownedMessagingHost(snapshot, session.hostId);
    if (
      host.authFingerprint !== session.hostAuthFingerprint ||
      !activeHostEngines(host.engines, ownedEngineState(snapshot)).includes(session.engine as Engine)
    )
      return false;
  } catch {
    return false;
  }
  if (claim.ownershipMode === 'timed') return Boolean(legacyDrainFor(owner)?.resourceClaim(claim.id, claim.sessionId, claim.generation));
  return Boolean(
    claim.ownershipMode === 'connection' &&
    claim.nativeInstanceId &&
    session &&
    !session.endedAt &&
    session.bindingGeneration === claim.generation &&
    nativeClaimAttachment(owner, session, claim.nativeInstanceId),
  );
}
export function ownedClaimView(claim: OwnedResourceClaim, owner?: OwnerRuntime) {
  const continuedBy = claim.state === 'released' && (claim.blockers as Array<{ id: string; state: string }>).find(row => row.state === 'continued');
  const drain = owner && claim.ownershipMode === 'timed' && legacyDrainFor(owner);
  const deadline = drain && drain.resourceClaim(claim.id, claim.sessionId, claim.generation)
    ? drain.protectedDeadline(claim.sessionId, claim.generation) : null;
  return {
    id: claim.id,
    session_id: claim.sessionId,
    generation: claim.generation,
    purpose: claim.purpose,
    resources: claim.resources,
    state: claim.state,
    blockers: claim.blockers,
    ownership_mode: claim.ownershipMode,
    native_instance_id: claim.nativeInstanceId,
    uncertainty_reason: claim.uncertaintyReason,
    expires_at: claim.ownershipMode === 'connection' ? null : deadline === null ? claim.expiresAt : new Date(deadline).toISOString(),
    presence_source: claim.ownershipMode === 'connection' ? 'connection' : 'legacy_drain',
    created_at: claim.createdAt,
    isolation_available:
      claim.state === 'waiting' &&
      !claim.repliedAt &&
      Date.now() - Date.parse(claim.createdAt) >= NEGOTIATION_SECONDS * 1000 &&
      (claim.resources as Resource[]).every(
        (resource) => resource.kind === 'path' || resource.kind === 'git',
      ),
    response_received: Boolean(claim.repliedAt),
    ...(continuedBy ? { continued_by_claim_id: continuedBy.id } : {}),
  };
}
export function stageClaimAnnouncement(
  ctx: OwnerMutationContext,
  keyring: Keyring,
  sessionId: string,
  body: Record<string, unknown>,
): void {
  for (const member of ctx.draft.table('agentScopeMembers').by('sessionId', sessionId))
    stageScopeEvent(ctx, keyring, member.scopeId, 'claim', sessionId, body);
}
/**
 * An uncertain claim protects an operation that might still be running, but
 * only while its owner can still come back to finish it. A holder whose session
 * ended, or that has been offline past the reconnect grace (owner-liveness.ts),
 * runs nothing under this claim, so keeping it only blocks everyone else. That
 * covers a crashed agent that is never finalized as well as one that exited.
 * A waiting claim of a gone holder reserves nothing and is released too. Only
 * the connection-loss reasons qualify: an outcome the owner reported as
 * unknown stays uncertain for an operator. A live successor on the same
 * transcript may still continue the claim through
 * `resource_claim_status({renew:true})`, so it keeps the claim while present.
 */
export function claimOwnerGone(
  owner: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  claim: StateRow<'agentResourceClaims'>,
  now = Date.now(),
): boolean {
  if (
    claim.state !== 'waiting' &&
    (claim.state !== 'uncertain' || !['disconnected', 'owner_restart'].includes(claim.uncertaintyReason ?? ''))
  )
    return false;
  return holderReleasable(owner, snapshot, claim.sessionId, now);
}
export function claimReconciliationNeeded(
  owner: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  now = Date.now(),
): boolean {
  return snapshot.claims.all().some((claim) => {
    if (claimOwnerGone(owner, snapshot, claim, now)) return true;
    if (claim.state === 'active') return !claimContinuouslyHeld(owner, snapshot, claim);
    if (
      claim.ownershipMode !== 'connection' ||
      claim.state !== 'uncertain' ||
      !['disconnected', 'owner_restart'].includes(claim.uncertaintyReason ?? '') ||
      !claimContinuouslyHeld(owner, snapshot, claim)
    )
      return false;
    const session = snapshot.sessions.get(claim.sessionId)!;
    const attachment = nativeClaimAttachment(owner, session, claim.nativeInstanceId)!;
    const report = ownerPresence(owner).details(attachment.id) as { active_claim_ids?: unknown } | undefined;
    return Array.isArray(report?.active_claim_ids) && report.active_claim_ids.includes(claim.id);
  });
}
export function stageClaimReconciliation(
  ctx: OwnerMutationContext,
  owner: OwnerRuntime,
  keyring: Keyring,
  now = Date.now(),
): boolean {
  let changed = false;
  for (const claim of ctx.draft.table('agentResourceClaims').all()) {
    const snapshot = ctx.draft.view();
    if (claim.state === 'active' && !claimContinuouslyHeld(owner, snapshot, claim)) {
      stageUpdate(ctx, 'agentResourceClaims', claim.id, {
        state: 'uncertain',
        uncertaintyReason: 'disconnected',
        updatedAt: new Date().toISOString(),
      });
      stageClaimAnnouncement(ctx, keyring, claim.sessionId, {
        claim_id: claim.id,
        action: 'uncertain',
        purpose: claim.purpose,
      });
      changed = true;
    } else if (claimOwnerGone(owner, snapshot, claim, now)) {
      const ended = Boolean(snapshot.sessions.get(claim.sessionId)?.endedAt) || !snapshot.sessions.get(claim.sessionId);
      stageUpdate(ctx, 'agentResourceClaims', claim.id, {
        state: 'released',
        uncertaintyReason: null,
        updatedAt: new Date(now).toISOString(),
      });
      stageClaimAnnouncement(ctx, keyring, claim.sessionId, {
        claim_id: claim.id,
        action: 'released',
        reason: ended ? 'session_ended' : 'owner_offline',
        purpose: claim.purpose,
      });
      adminAudit(ctx, ended ? 'agent_coordination.session_ended_release' : 'agent_coordination.owner_offline_release', {
        claim_id: claim.id,
        session_id: claim.sessionId,
        previous_state: claim.state,
        previous_reason: claim.uncertaintyReason,
      });
      changed = true;
    } else if (
      claim.ownershipMode === 'connection' &&
      claim.state === 'uncertain' &&
      ['disconnected', 'owner_restart'].includes(claim.uncertaintyReason ?? '') &&
      claimContinuouslyHeld(owner, snapshot, claim)
    ) {
      const session = snapshot.sessions.get(claim.sessionId)!,
        attachment = nativeClaimAttachment(owner, session, claim.nativeInstanceId)!;
      const report = ownerPresence(owner).details(attachment.id) as
        | { active_claim_ids?: unknown }
        | undefined;
      if (!Array.isArray(report?.active_claim_ids) || !report.active_claim_ids.includes(claim.id)) continue;
      stageUpdate(ctx, 'agentResourceClaims', claim.id, {
        state: 'active',
        uncertaintyReason: null,
        updatedAt: new Date().toISOString(),
      });
      stageClaimAnnouncement(ctx, keyring, claim.sessionId, {
        claim_id: claim.id,
        action: 'recovered',
        purpose: claim.purpose,
      });
      changed = true;
    }
  }
  return changed;
}
export function ownedClaimBlockers(
  owner: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  resources: Resource[],
  exclude?: string,
  caller?: ScopeSession,
) {
  const result: Array<Record<string, unknown> & { id: string; session_id: string; state: string }> = [];
  for (const claim of snapshot.claims.all()) {
    if (!['active', 'uncertain'].includes(claim.state) || claim.id === exclude) continue;
    if (
      caller &&
      claim.sessionId === caller.id &&
      claim.generation === caller.bindingGeneration &&
      claim.state === 'active' &&
      claimContinuouslyHeld(owner, snapshot, claim)
    )
      continue;
    if (!(claim.resources as Resource[]).some((a) => resources.some((b) => overlaps(a, b)))) continue;
    const session = snapshot.sessions.get(claim.sessionId),
      address = session?.agentBusAddressId ? snapshot.addresses.get(session.agentBusAddressId) : undefined;
    result.push({
      id: claim.id,
      session_id: claim.sessionId,
      state: claim.state,
      purpose: claim.purpose,
      resources: claim.resources,
      generation: claim.generation,
      owner_address: address?.address ?? null,
      owner_name: session?.launchName ?? null,
      ...(claim.state === 'uncertain' && claim.uncertaintyReason !== 'reported_unknown'
        ? {
            recovery: {
              automatic: true,
              release_after_offline_seconds: OWNER_RECONNECT_GRACE_MS / 1000,
              instruction:
                'The owner lost its connection. It can recover the claim by reconnecting; if it stays offline, the claim is released automatically. Never take over an uncertain resource.',
            },
          }
        : claim.state === 'uncertain'
        ? {
            recovery: {
              method: 'POST',
              path: '/admin/agent-messaging/scopes/resolve',
              claim_id: claim.id,
              operator_required: true,
              instruction:
                'Operator must verify the operation has ended and provide an audited reason; never take over an uncertain resource.',
            },
          }
        : {}),
    });
  }
  for (const peer of snapshot.sessions.all()) {
    if (!coordinationPresent(owner, peer) || coordinationProtocol(peer) === 1) continue;
    const workspace = readWorkspace(peer.workspace),
      occupied: Resource = {
        kind: 'path',
        host_id: peer.hostId,
        path: workspace?.git_root ?? workspace?.cwd ?? peer.cwd,
      };
    if (resources.some((resource) => overlaps(resource, occupied)))
      result.push({ id: `presence:${peer.id}`, session_id: peer.id, state: 'limited_coordination' });
  }
  for (const lease of snapshot.table('gitMergeRequests').by('verdict', 'allow')) {
    if (lease.completedAt || Date.parse(lease.leaseExpiresAt ?? '') <= Date.now()) continue;
    const worktree = snapshot.table('gitWorktrees').get(lease.worktreeId),
      clone = worktree && snapshot.table('gitClones').get(worktree.cloneId);
    if (
      !worktree ||
      !clone ||
      (caller &&
        caller.id === worktree.agentSessionId &&
        caller.bindingGeneration === worktree.agentBindingGeneration)
    )
      continue;
    const occupied: Resource = { kind: 'path', host_id: clone.hostId, path: worktree.worktreePath };
    if (
      resources.some(
        (resource) =>
          overlaps(resource, occupied) ||
          (resource.kind === 'git' &&
            resource.host_id === clone.hostId &&
            resource.common_dir === clone.cloneDir &&
            (!resource.branch || resource.branch === lease.targetBranch)),
      )
    )
      result.push({ id: lease.id, session_id: 'legacy', state: 'legacy_merge_lease' });
  }
  return result;
}

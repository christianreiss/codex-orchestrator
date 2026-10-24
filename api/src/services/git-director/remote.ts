import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { claimContinuouslyHeld } from '../../control-plane/state/resource-claims.js';
import { ownedMessagingHost } from '../../control-plane/state/messaging.js';
import { ownedCredentialDeadline } from '../../control-plane/credentials.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import { and, eq, isNull } from 'drizzle-orm';
import { agentResourceClaims, agentSessions, agentBusAddresses, hosts, type AgentSession } from '../../db/schema.js';
import { ForbiddenError, ConflictError, NotFoundError } from '../../http/errors.js';
import type { AgentMessagingDb } from '../agent-messaging/types.js';
import { overlaps, resourceSchema, type Resource } from '../agent-coordination/model.js';

export interface GitProvenance {
  sessionId: string;
  generation: number;
  claimId: string;
  hostId: number;
  commonDir: string;
  branch: string;
  worktreePath: string;
}

/** Private server-side provenance, never accepted by the host-key MCP API. */
export async function remoteGitOwner(tx: AgentMessagingDb, proof: GitProvenance, composed?: OwnerStateSnapshot) {
  // Validate canonical scope before reading or mutating any registry row.
  const pathResource = resourceSchema.parse({ kind: 'path', host_id: proof.hostId, path: proof.worktreePath });
  const gitResource = resourceSchema.parse({ kind: 'git', host_id: proof.hostId, common_dir: proof.commonDir, branch: proof.branch });
  if (pathResource.kind !== 'path' || gitResource.kind !== 'git' || pathResource.path !== proof.worktreePath || gitResource.common_dir !== proof.commonDir)
    throw new ForbiddenError('Remote Git paths must be canonical', 'git_remote_scope_mismatch');
  const owner=ownerRuntimeFor(tx);
  if(owner){
    owner.assertOwner();const snapshot=composed??owner.state.snapshot(),session=snapshot.sessions.get(proof.sessionId),claim=snapshot.claims.get(proof.claimId);
    if(!session||session.endedAt||session.bindingGeneration!==proof.generation||(session.adapterCapabilities as Record<string,unknown>|null)?.scope_protocol_version!==1||ownedCredentialDeadline(snapshot,'session',session.id)<=Date.now())throw new ForbiddenError('Originating managed session is no longer live','git_remote_binding_stale');
    const source=ownedMessagingHost(snapshot,session.hostId);
    if(source.authFingerprint!==session.hostAuthFingerprint)throw new ForbiddenError('Originating host credential changed','git_remote_binding_stale');
    if(!claim||claim.sessionId!==session.id||claim.generation!==proof.generation||claim.state!=='active'||!claimContinuouslyHeld(owner,snapshot,claim))throw new ConflictError('Remote Git requires an active claim owned by this session binding','git_remote_claim_required');
    const required:Resource[]=[pathResource,gitResource],resources=claim.resources as Resource[];
    if(!required.every(resource=>resources.some(held=>overlaps(held,resource)&&(held.kind!=='path'||resource.kind!=='path'||held.path===resource.path||resource.path.startsWith(held.path==='/'?'/':held.path+'/')))))throw new ForbiddenError('Claim does not cover the remote checkout and branch','git_remote_scope_mismatch');
    const host=snapshot.hosts.get(proof.hostId),address=session.agentBusAddressId?snapshot.addresses.get(session.agentBusAddressId):undefined;
    if(!host||host.internalRole||host.status!=='active')throw new NotFoundError('Active target host not found');
    if(!address||address.currentSessionId!==session.id||address.bindingGeneration!==proof.generation||address.enabled!==1||address.archivedAt)throw new ForbiddenError('Originating address binding changed','git_remote_binding_stale');
    return {host,session};
  }
  const [session] = await tx.select().from(agentSessions).where(and(eq(agentSessions.id, proof.sessionId), isNull(agentSessions.endedAt)));
  const [claim] = await tx.select().from(agentResourceClaims).where(eq(agentResourceClaims.id, proof.claimId));
  if (!session || (session.adapterCapabilities as Record<string, unknown> | null)?.scope_protocol_version !== 1 || session.bindingGeneration !== proof.generation || session.bridgeExpiresAt <= new Date().toISOString())
    throw new ForbiddenError('Originating managed session is no longer live', 'git_remote_binding_stale');
  if (!claim || claim.sessionId !== session.id || claim.generation !== proof.generation || claim.state !== 'active' || Date.parse(claim.expiresAt) <= Date.now())
    throw new ConflictError('Remote Git requires an active claim owned by this session binding', 'git_remote_claim_required');
  const resources = claim.resources as Resource[];
  const required: Resource[] = [
    { kind: 'path', host_id: proof.hostId, path: proof.worktreePath },
    { kind: 'git', host_id: proof.hostId, common_dir: proof.commonDir, branch: proof.branch },
  ];
  if (!required.every((r) => resources.some((own) => overlaps(own, r) &&
    (own.kind !== 'path' || r.kind !== 'path' || own.path === r.path || r.path.startsWith(own.path + '/')))))
    throw new ForbiddenError('Claim does not cover the remote checkout and branch', 'git_remote_scope_mismatch');
  const [host] = await tx.select().from(hosts).where(and(eq(hosts.id, proof.hostId), isNull(hosts.internalRole)));
  if (!host || host.status !== 'active') throw new NotFoundError('Active target host not found');
  const [address] = session.agentBusAddressId ? await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, session.agentBusAddressId)) : [];
  if (!address || address.currentSessionId !== session.id || address.bindingGeneration !== proof.generation || address.enabled !== 1 || address.archivedAt)
    throw new ForbiddenError('Originating address binding changed', 'git_remote_binding_stale');
  if (!session.agentBusAddressId) throw new ForbiddenError('Originating session has no agent address');
  return { host, session };
}

export function remoteAddress(session: Pick<AgentSession,'agentBusAddressId'|'id'|'bindingGeneration'|'username'>) {
  return { id: session.agentBusAddressId!, sessionId: session.id, generation: session.bindingGeneration, username: session.username };
}

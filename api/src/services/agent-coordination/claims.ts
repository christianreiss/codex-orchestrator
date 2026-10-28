import { claimConnectionError } from './claim-connection-error.js';
import { CLAIM_RECOVERY_GUIDANCE } from './recovery-guidance.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import type { ScopeSession } from '../../control-plane/state/coordination.js';
import { canonicalCommand } from '../../control-plane/commands.js';
import { persistAuditLog } from '../audit-log.js';
import { resumedNativeAttachment } from '../../control-plane/state/native-resume.js';
import { adminAudit } from '../../control-plane/state/admin.js';
import { mutateOwnerState, ownerRuntimeFor, type OwnerRuntime } from '../../control-plane/state/runtime.js';
import { coordinationSession, coordinationProtocol, coordinationPresent, stageScopeReconciliation } from '../../control-plane/state/coordination.js';
import { claimContinuouslyHeld, nativeClaimAttachment, ownedClaimView, ownedClaimBlockers, stageClaimReconciliation, stageClaimAnnouncement, stageClaimActivation, stageClaimPromotion, stageWaitingClaimRefusal } from '../../control-plane/state/resource-claims.js';
import { stageCoordinationNotice } from '../../control-plane/state/coordination-notices.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import type { Json } from '../../control-plane/commands.js';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  agentBusAddresses,
  agentResourceClaims,
  agentScopeMembers,
  agentSessions,
  gitClones,
  gitMergeRequests,
  gitWorktrees,
  hosts,
  type AgentSession,
} from '../../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../http/errors.js';
import { wsPublisher } from '../../ws/publisher.js';
import type { AgentMessagingDb } from '../agent-messaging/types.js';
import type { AgentCoordination } from './index.js';
import { readWorkspace } from '../agent-messaging/workspace.js';
import {
  parseAcquireForHost,
  claimStatusSchema,
  CLAIM_SECONDS,
  NEGOTIATION_SECONDS,
  claimArrivalOrder,
  overlaps,
  waiterBlocks,
  type Resource,
} from './model.js';

type Claim = typeof agentResourceClaims.$inferSelect;
function resumeProof(owner: OwnerRuntime, snapshot: OwnerStateSnapshot, claim: Readonly<Claim>, session: ScopeSession) {
  if (claim.ownershipMode !== 'connection' || !claim.nativeInstanceId || claim.state !== 'uncertain' ||
      !['owner_restart', 'disconnected'].includes(claim.uncertaintyReason ?? '')) return undefined;
  return resumedNativeAttachment(owner, snapshot, claim.sessionId, claim.generation, session);
}

export class ResourceClaims {
  constructor(private readonly core: AgentCoordination) {}
  view(claim: Claim) {
    return {
      id: claim.id,
      session_id: claim.sessionId,
      generation: claim.generation,
      purpose: claim.purpose,
      resources: claim.resources,
      state: claim.state,
      blockers: claim.blockers,
      expires_at: claim.expiresAt,
      created_at: claim.createdAt,
      isolation_available:
        claim.state === 'waiting' &&
        !claim.repliedAt &&
        Date.now() - Date.parse(claim.createdAt) >= NEGOTIATION_SECONDS * 1000 &&
        (claim.resources as Resource[]).every((r) => r.kind === 'path' || r.kind === 'git'),
      response_received: Boolean(claim.repliedAt),
    };
  }
  async sweep(tx: AgentMessagingDb, sessions: AgentSession[], now = Date.now()) {
    const claims = await tx.select().from(agentResourceClaims).where(eq(agentResourceClaims.state, 'active'));
    for (const claim of claims) {
      const owner = sessions.find((s) => s.id === claim.sessionId);
      if (
        !owner ||
        !this.core.present(owner, now) ||
        owner.bindingGeneration !== claim.generation ||
        Date.parse(claim.expiresAt) <= now
      ) {
        await tx
          .update(agentResourceClaims)
          .set({ state: 'uncertain', updatedAt: new Date().toISOString() })
          .where(eq(agentResourceClaims.id, claim.id));
        await this.announce(tx, claim.sessionId, {
          claim_id: claim.id,
          action: 'uncertain',
          purpose: claim.purpose,
        });
      }
    }
  }
  async announce(tx: AgentMessagingDb, sessionId: string, body: Record<string, unknown>) {
    const memberships = await tx
      .select()
      .from(agentScopeMembers)
      .where(eq(agentScopeMembers.sessionId, sessionId));
    for (const member of memberships) await this.core.event(tx, member.scopeId, 'claim', sessionId, body);
  }
  async blockers(tx: AgentMessagingDb, resources: Resource[], exclude?: string, owner?: AgentSession) {
    const held = await tx
      .select()
      .from(agentResourceClaims)
      .where(inArray(agentResourceClaims.state, ['active', 'uncertain', 'waiting']));
    const ownGrant = (c: Claim) => Boolean(owner && c.sessionId === owner.id && c.generation === owner.bindingGeneration &&
      c.state === 'active' && Date.parse(c.expiresAt) > Date.now());
    const subject = exclude ? held.find((c) => c.id === exclude) : undefined;
    const ownResources = held.filter(ownGrant).flatMap((c) => c.resources as Resource[]);
    // Live waiting claims ahead in arrival order queue this one (see ownedClaimBlockers).
    const conflicting = held.filter((c) => c.id !== exclude && !ownGrant(c) &&
      (c.resources as Resource[]).some((a) => resources.some((b) => overlaps(a, b))) &&
      (c.state !== 'waiting' || ((!subject || claimArrivalOrder(c, subject) < 0) &&
        Date.parse(c.expiresAt) > Date.now() && waiterBlocks(resources, c.resources as Resource[], ownResources))));
    const ownerIds = [...new Set(conflicting.map((c) => c.sessionId))];
    const sessions = ownerIds.length ? await tx.select({ id: agentSessions.id, agentBusAddressId: agentSessions.agentBusAddressId,
      launchName: agentSessions.launchName }).from(agentSessions).where(inArray(agentSessions.id, ownerIds)) : [];
    const addressIds = sessions.flatMap((s) => s.agentBusAddressId ? [s.agentBusAddressId] : []);
    const addresses = addressIds.length ? await tx.select({ id: agentBusAddresses.id, address: agentBusAddresses.address })
      .from(agentBusAddresses).where(inArray(agentBusAddresses.id, addressIds)) : [];
    const blockers: Array<Record<string, unknown> & { id: string; session_id: string; state: string }> = conflicting
      .map((c) => {
        const session = sessions.find((s) => s.id === c.sessionId);
        return { id: c.id, session_id: c.sessionId, state: c.state, purpose: c.purpose,
          resources: c.resources, generation: c.generation,
          owner_address: addresses.find((a) => a.id === session?.agentBusAddressId)?.address ?? null,
          owner_name: session?.launchName ?? null,
          ...(c.state === 'uncertain' ? { recovery: {
            method: 'POST', path: '/admin/agent-messaging/scopes/resolve',
            claim_id: c.id, operator_required: true,
            instruction: 'Operator must verify the operation has ended and provide an audited reason; never take over an uncertain resource.'
          }} : {}),
        };
      });
    const peers = await tx.select().from(agentSessions).where(isNull(agentSessions.endedAt));
    for (const peer of peers) {
      if (!this.core.present(peer) || this.core.protocol(peer) === 1) continue;
      const w = readWorkspace(peer.workspace);
      const r: Resource = { kind: 'path', host_id: peer.hostId, path: w?.git_root ?? w?.cwd ?? peer.cwd };
      if (resources.some((resource) => overlaps(resource, r)))
        blockers.push({ id: `presence:${peer.id}`, session_id: peer.id, state: 'limited_coordination' });
    }

    // Older clients' merge leases are occupied resources too; never bypass them.
    const legacy = await tx
      .select({ lease: gitMergeRequests, worktree: gitWorktrees, clone: gitClones })
      .from(gitMergeRequests)
      .innerJoin(gitWorktrees, eq(gitMergeRequests.worktreeId, gitWorktrees.id))
      .innerJoin(gitClones, eq(gitWorktrees.cloneId, gitClones.id))
      .where(eq(gitMergeRequests.verdict, 'allow'));
    for (const row of legacy) {
      if (owner && owner.id === row.worktree.agentSessionId &&
        owner.bindingGeneration === row.worktree.agentBindingGeneration) continue;
      if (row.lease.completedAt || Date.parse(row.lease.leaseExpiresAt ?? '') <= Date.now()) continue;
      const r: Resource = { kind: 'path', host_id: row.clone.hostId, path: row.worktree.worktreePath };
      if (
        resources.some(
          (resource) =>
            overlaps(resource, r) ||
            (resource.kind === 'git' &&
              resource.host_id === row.clone.hostId &&
              resource.common_dir === row.clone.cloneDir &&
              (!resource.branch || resource.branch === row.lease.targetBranch)),
        )
      )
        blockers.push({ id: row.lease.id, session_id: 'legacy', state: 'legacy_merge_lease' });
    }
    return blockers;
  }
  async acquire(id: string, token: string, input: unknown) {
    const owner = ownerRuntimeFor(this.core.db);
    if (owner) {
      const admitted = coordinationSession(owner,owner.state.snapshot(),id,token)!;
      const body = parseAcquireForHost(input, admitted.hostId);
      const nativeInstanceId = nativeClaimAttachment(owner,admitted)?.scope.native_instance_id;
      if (!nativeInstanceId) throw claimConnectionError(owner, owner.state.snapshot(), admitted);
      const result = await mutateOwnerState(owner,{ kind: 'coordination.claim.acquire', principal: `session:${id}`, id: body.client_request_id, payload: body as Json, authorize: snapshot => { const current = coordinationSession(owner,snapshot,id,token)!; if (!nativeClaimAttachment(owner,current,nativeInstanceId)) throw claimConnectionError(owner, snapshot, current, 'Native connection changed', nativeInstanceId); }, prepare: ctx => {
        const session = coordinationSession(owner,ctx.snapshot,id,token)!;
        if (coordinationProtocol(session) !== 1) throw new ForbiddenError('Scope protocol 1 required');
        const attachment = nativeClaimAttachment(owner,session,nativeInstanceId);
        if (!attachment?.scope.native_instance_id) throw claimConnectionError(owner, ctx.snapshot, session, undefined, nativeInstanceId);
        stageScopeReconciliation(ctx,owner,this.core.keyring); stageClaimReconciliation(ctx,owner,this.core.keyring);
        const existing = ctx.draft.table('agentResourceClaims').by('sessionId',id).find(row => row.requestId === body.client_request_id);
        if (existing) {
          if (existing.purpose !== body.purpose || JSON.stringify(existing.resources) !== JSON.stringify(body.resources)) throw new ConflictError('Claim request ID reused', 'claim_request_conflict');
          return ownedClaimView(existing, owner) as Json;
        }
        if (body.resources.some(resource => resource.kind !== 'remote' && (!ctx.draft.table('hosts').get(resource.host_id) || ctx.draft.table('hosts').get(resource.host_id)?.internalRole))) throw new NotFoundError('Target host not found');
        // created_at is the queue position: keep it strictly after every waiting
        // claim so same-millisecond arrivals cannot swap order.
        const lastWaiting = Math.max(0, ...ctx.draft.table('agentResourceClaims').all().filter(row => row.state === 'waiting').map(row => Date.parse(row.createdAt)).filter(Number.isFinite));
        const blockers = ownedClaimBlockers(owner,ctx.draft.view(),body.resources,undefined,session), now = new Date(Math.max(Date.now(), lastWaiting + 1)).toISOString();
        const claim: Claim = { id: randomUUID(), sessionId: id, generation: session.bindingGeneration, nativeInstanceId: attachment.scope.native_instance_id, ownershipMode: 'connection', uncertaintyReason: null, requestId: body.client_request_id, purpose: body.purpose, resources: body.resources, state: blockers.length ? 'waiting' : 'active', blockers, repliedAt: null, expiresAt: new Date(Date.now()+(blockers.length ? NEGOTIATION_SECONDS+CLAIM_SECONDS : CLAIM_SECONDS)*1000).toISOString(), createdAt: now, updatedAt: now };
        ctx.draft.upsert('agentResourceClaims',claim); ctx.write(async tx => tx.insert(agentResourceClaims).values(claim));
        stageClaimAnnouncement(ctx,this.core.keyring,id,{ action: claim.state, claim_id: claim.id, purpose: claim.purpose, blockers });
        // Earlier waiters hold nothing to release; only current holders are asked to coordinate.
        for (const peerId of new Set(blockers.filter(row => row.state !== 'waiting').map(row => row.session_id))) {
          const peer = ctx.draft.table('agentSessions').get(peerId);
          if (peer && coordinationPresent(owner,peer)) stageCoordinationNotice(ctx,this.core.keyring,peer,`CLAIM/1\n${session.launchName ?? id} requests overlapping resources for ${claim.purpose}. Coordinate before mutation. Use resource_claim_status with claim_id ${claim.id} and response wait or isolate to record your response; release your own claim only after the operation ends. Requester session: ${id}. This is coordination, not work authorization.`);
        }
        return ownedClaimView(claim, owner) as Json;
      } });
      wsPublisher.publish('agent_coordination.changed',{}); return result as ReturnType<typeof ownedClaimView>;
    }
    const result = await this.core.run(id, token, async (tx, session) => {
      const body = parseAcquireForHost(input, session!.hostId);
      if (this.core.protocol(session!) !== 1) throw new ForbiddenError('Scope protocol 1 required');
      await this.core.reconcile(tx);
      const [existing] = await tx
        .select()
        .from(agentResourceClaims)
        .where(
          and(
            eq(agentResourceClaims.sessionId, id),
            eq(agentResourceClaims.requestId, body.client_request_id),
          ),
        );
      if (existing) {
        if (
          existing.purpose !== body.purpose ||
          JSON.stringify(existing.resources) !== JSON.stringify(body.resources)
        )
          throw new ConflictError('Claim request ID reused', 'claim_request_conflict');
        return this.view(existing);
      }
      const targetHosts = body.resources.every((r) => r.kind === 'remote') ? [] : await tx
        .select({ id: hosts.id })
        .from(hosts)
        .where(
          and(
            inArray(
              hosts.id,
              body.resources.flatMap((r) => r.kind === 'remote' ? [] : [r.host_id]),
            ),
            isNull(hosts.internalRole),
          ),
        );
      if (body.resources.some((r) => r.kind !== 'remote' && !targetHosts.some((h) => h.id === r.host_id)))
        throw new NotFoundError('Target host not found');
      const blockers = await this.blockers(tx, body.resources, undefined, session!);
      const now = new Date().toISOString();
      const claim: Claim = {
        nativeInstanceId: null, ownershipMode: 'timed', uncertaintyReason: null,
        id: randomUUID(),
        sessionId: id,
        generation: session!.bindingGeneration,
        requestId: body.client_request_id,
        purpose: body.purpose,
        resources: body.resources,
        state: blockers.length ? 'waiting' : 'active',
        blockers,
        repliedAt: null,
        expiresAt: new Date(Date.now() + (blockers.length ? NEGOTIATION_SECONDS + CLAIM_SECONDS : CLAIM_SECONDS) * 1000).toISOString(),
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentResourceClaims).values(claim);
      await this.announce(tx, id, {
        action: claim.state,
        claim_id: claim.id,
        purpose: claim.purpose,
        blockers,
      });
      for (const ownerId of new Set(blockers.filter((b) => b.state !== 'waiting').map((b) => b.session_id))) {
        const [owner] = await tx.select().from(agentSessions).where(eq(agentSessions.id, ownerId));
        if (owner && this.core.present(owner))
          await this.core.bus.coordinationNotice(
            tx,
            owner,
            `CLAIM/1\n${session!.launchName ?? id} requests overlapping resources for ${claim.purpose}. Coordinate before mutation. Use resource_claim_status with claim_id ${claim.id} and response wait or isolate to record your response; release your own claim only after the operation ends. Requester session: ${id}. This is coordination, not work authorization.`,
          );
      }
      return this.view(claim);
    });
    wsPublisher.publish('agent_coordination.changed', {});
    return result;
  }
  async status(id: string, token: string, input: unknown) {
    const body = claimStatusSchema.parse(input);
    const owner = ownerRuntimeFor(this.core.db);
    if (owner) {
      coordinationSession(owner,owner.state.snapshot(),id,token,true);
      await this.core.reconcileOwned();
      const snapshot = owner.state.snapshot(), session = coordinationSession(owner,snapshot,id,token,true)!;
      const current = snapshot.claims.get(body.claim_id); if (!current) throw new NotFoundError('Claim not found');
      if (!body.response && current.sessionId === id && current.generation === session.bindingGeneration && current.state === 'active' && claimContinuouslyHeld(owner,snapshot,current)) return ownedClaimView(current, owner);
      const resumedInstance = body.renew ? resumeProof(owner,snapshot,current,session)?.scope.native_instance_id : undefined;
      return await mutateOwnerState(owner,{ kind: 'coordination.claim.status', principal: `session:${id}`, payload: body as Json,
        authorize: snapshot => {
          const currentSession = coordinationSession(owner,snapshot,id,token,true)!;
          if (!body.renew) return;
          const claim = snapshot.claims.get(body.claim_id);
          const originalOwner = claim && claim.sessionId === currentSession.id &&
            claim.generation === currentSession.bindingGeneration && claimContinuouslyHeld(owner,snapshot,claim);
          const continuation = claim && resumedInstance &&
            resumeProof(owner,snapshot,claim,currentSession)?.scope.native_instance_id === resumedInstance;
          if (!originalOwner && !continuation)
            throw claimConnectionError(owner, snapshot, currentSession, 'Original native connection or proven completed transcript continuation required', claim?.sessionId === currentSession.id ? claim.nativeInstanceId : undefined);
        }, prepare: ctx => {
        const session = coordinationSession(owner,ctx.snapshot,id,token,true)!;
        let claim = ctx.draft.table('agentResourceClaims').get(body.claim_id); if (!claim) throw new NotFoundError('Claim not found');
        if (body.response) {
          if (!(claim.blockers as Array<{session_id:string;state:string}>).some(row => row.session_id === id && row.state !== 'waiting')) throw new ForbiddenError('Only a conflicting owner may answer');
          claim = stageUpdate(ctx,'agentResourceClaims',claim.id,{ repliedAt: new Date().toISOString() });
          stageClaimAnnouncement(ctx,this.core.keyring,claim.sessionId,{ action: 'response', claim_id: claim.id, response: body.response, responder: id });
          return ownedClaimView(claim, owner) as Json;
        }
        if (claim.sessionId !== id && body.renew) {
          const attachment = resumeProof(owner,ctx.draft.view(),claim,session);
          if (attachment && attachment.scope.native_instance_id === resumedInstance) {
            const previousSessionId = claim.sessionId;
            const collision = ctx.draft.table('agentResourceClaims').by('sessionId', session.id)
              .find(row => row.id !== claim!.id && row.requestId === claim!.requestId);
            if (collision) {
              if (collision.state !== 'waiting' || collision.purpose !== claim.purpose ||
                  canonicalCommand(collision.resources as Json) !== canonicalCommand(claim.resources as Json))
                throw new ConflictError('The resumed session already used this request ID for different work','claim_request_conflict');
              // A retry may have queued the same request in the new lifecycle.
              // Preserve its idempotency key on the continued grant, and retain
              // the canceled waiting row under a fresh internal identity.
              stageUpdate(ctx,'agentResourceClaims',collision.id,{ requestId: randomUUID(), state: 'released', uncertaintyReason: null, blockers: [{ id: claim.id, session_id: session.id, state: 'continued' }], updatedAt: new Date().toISOString() });
            }
            claim = stageUpdate(ctx,'agentResourceClaims',claim.id,{ sessionId: session.id, generation: session.bindingGeneration, nativeInstanceId: attachment.scope.native_instance_id!, state: 'active', uncertaintyReason: null, updatedAt: new Date().toISOString() });
            const event = { action: 'resumed', claim_id: claim.id, previous_session_id: previousSessionId, session_id: session.id, native_session_id: session.upstreamSessionId, superseded_waiting_claim_id: collision?.id ?? null };
            ctx.write(tx => persistAuditLog(tx, { hostId: session.hostId, engine: session.engine, action: 'resource_claim.resumed', details: JSON.stringify(event), createdAt: new Date().toISOString() }));
            stageClaimAnnouncement(ctx,this.core.keyring,previousSessionId,event);
            stageClaimAnnouncement(ctx,this.core.keyring,session.id,event);
          }
        }
        if (claim.sessionId !== id) throw new ForbiddenError('Claim belongs to another session');
        if (claim.generation !== session.bindingGeneration) throw new ConflictError('Claim belongs to an older binding','claim_generation_stale');
        const proof = claimContinuouslyHeld(owner,ctx.snapshot,claim);
        if (body.renew && claim.state === 'uncertain' && ['owner_restart','disconnected'].includes(claim.uncertaintyReason ?? '') && proof) {
          claim = stageUpdate(ctx,'agentResourceClaims',claim.id,{ state: 'active', uncertaintyReason: null, updatedAt: new Date().toISOString() });
          stageClaimAnnouncement(ctx,this.core.keyring,id,{ action: 'recovered', claim_id: claim.id, purpose: claim.purpose });
        }
        if (claim.state === 'waiting' && ctx.snapshot.setting('agent_coordination_enabled') === '1') {
          const blockers = ownedClaimBlockers(owner,ctx.draft.view(),claim.resources as Resource[],claim.id,session);
          if (!blockers.length && !proof) throw claimConnectionError(owner, ctx.snapshot, session, 'The original native attachment is required to activate this claim', claim.nativeInstanceId);
          if (!blockers.length) claim = stageClaimActivation(ctx,this.core.keyring,claim);
          else if (JSON.stringify(blockers) !== JSON.stringify(claim.blockers)) claim = stageUpdate(ctx,'agentResourceClaims',claim.id,{ blockers,updatedAt:new Date().toISOString() });
        }
        if (body.renew && (!['active','waiting'].includes(claim.state) || !proof)) throw new ConflictError('Only the original connected owner can renew a live claim','claim_not_active');
        return ownedClaimView(claim, owner) as Json;
      } }) as ReturnType<typeof ownedClaimView>;
    }
    return this.core.run(
      id,
      token,
      async (tx, session) => {
        let [claim] = await tx
          .select()
          .from(agentResourceClaims)
          .where(eq(agentResourceClaims.id, body.claim_id));
        if (!claim) throw new NotFoundError('Claim not found');
        // The bus transaction already fences the caller's current binding.
        // An unchanged live lease only needs its owner and deadline, not a
        // reconciliation of every session, title, membership and claim.
        // Waiting, stale and third-party responses retain that reconciliation.
        if (body.response || claim.sessionId !== id || claim.generation !== session!.bindingGeneration ||
          claim.state !== 'active' || Date.parse(claim.expiresAt) <= Date.now() || !this.core.present(session!)) {
          await this.core.reconcile(tx);
          [claim] = await tx.select().from(agentResourceClaims).where(eq(agentResourceClaims.id, body.claim_id));
          if (!claim) throw new NotFoundError('Claim not found');
        }
        if (body.response) {
          if (!(claim.blockers as Array<{ session_id: string; state: string }>).some((b) => b.session_id === id && b.state !== 'waiting'))
            throw new ForbiddenError('Only a conflicting owner may answer');
          await tx
            .update(agentResourceClaims)
            .set({ repliedAt: new Date().toISOString() })
            .where(eq(agentResourceClaims.id, claim.id));
          await this.announce(tx, claim.sessionId, {
            action: 'response',
            claim_id: claim.id,
            response: body.response,
            responder: id,
          });
          claim.repliedAt = new Date().toISOString();
          return this.view(claim);
        }
        if (claim.sessionId !== id) throw new ForbiddenError('Claim belongs to another session');
        if (claim.generation !== session!.bindingGeneration)
          throw new ConflictError('Claim belongs to an older binding', 'claim_generation_stale');
        if (claim.state === 'waiting' && (await this.core.enabled(tx))) {
          const blockers = await this.blockers(tx, claim.resources as Resource[], claim.id, session!);
          claim.blockers = blockers;
          if (!blockers.length) {
            claim.state = 'active';
            claim.expiresAt = new Date(Date.now() + CLAIM_SECONDS * 1000).toISOString();
            await this.announce(tx, claim.sessionId, {
              action: 'active',
              claim_id: claim.id,
              purpose: claim.purpose,
            });
          }
          await tx
            .update(agentResourceClaims)
            .set({ blockers, state: claim.state, expiresAt: claim.expiresAt })
            .where(eq(agentResourceClaims.id, claim.id));
        }
        if (body.renew) {
          if (!['active', 'waiting'].includes(claim.state))
            throw new ConflictError('Only a live claim can be renewed', 'claim_not_active');
          claim.expiresAt = new Date(Date.now() + CLAIM_SECONDS * 1000).toISOString();
          await tx
            .update(agentResourceClaims)
            .set({ expiresAt: claim.expiresAt, updatedAt: new Date().toISOString() })
            .where(eq(agentResourceClaims.id, claim.id));
        }
        return this.view(claim);
      },
      true,
    );
  }
  async release(id: string | null, token: string | null, input: unknown, operatorId?: number) {
    const body = z
      .object({
        claim_id: z.string().uuid(),
        outcome: z.enum(['completed', 'canceled', 'unknown']),
        reason: z.string().trim().min(1).max(1000),
      })
      .strict()
      .parse(input);
    const owner = ownerRuntimeFor(this.core.db);
    if (owner) {
      const result = await mutateOwnerState(owner,{ kind: 'coordination.claim.release', principal: id ? `session:${id}` : `admin:${operatorId ?? 'unknown'}`, payload: body, authorize: snapshot => { const session = coordinationSession(owner,snapshot,id,token,true); const claim = snapshot.claims.get(body.claim_id); if (session && claim && claim.state !== 'released' && (claim.sessionId !== session.id || claim.generation !== session.bindingGeneration || !claimContinuouslyHeld(owner,snapshot,claim))) throw new ConflictError('Original owner proof required to release this claim.' + CLAIM_RECOVERY_GUIDANCE,'claim_owner_uncertain'); }, prepare: ctx => {
        const session = coordinationSession(owner,ctx.snapshot,id,token,true), claim = ctx.draft.table('agentResourceClaims').get(body.claim_id);
        if (!claim) throw new NotFoundError('Claim not found');
        if (session && (claim.sessionId !== id || claim.generation !== session.bindingGeneration)) throw new ForbiddenError('Claim belongs to a different session binding');
        if (!session && !operatorId) throw new ForbiddenError('Operator required');
        if (session && claim.state !== 'released' && !claimContinuouslyHeld(owner,ctx.snapshot,claim)) throw new ConflictError('Original native connection required to release this claim.' + CLAIM_RECOVERY_GUIDANCE,'claim_owner_uncertain');
        if (operatorId) adminAudit(ctx,'agent_coordination.resolved',{claim_id:claim.id,admin_user_id:operatorId,outcome:body.outcome,reason:body.reason});
        const state = body.outcome === 'unknown' ? 'uncertain' : 'released';
        if (claim.state === 'released') return ownedClaimView(claim, owner) as Json;
        const updated = stageUpdate(ctx,'agentResourceClaims',claim.id,{ state, uncertaintyReason: state === 'uncertain' ? 'reported_unknown' : null, updatedAt: new Date().toISOString() });
        stageClaimAnnouncement(ctx,this.core.keyring,claim.sessionId,{ action: state, claim_id: claim.id, reason: body.reason, ...(operatorId ? { operator_id: operatorId } : {}) });
        if (!session && claim.state === 'waiting' && state === 'released') stageWaitingClaimRefusal(ctx,this.core.keyring,claim,body.reason);
        // Hand freed resources to the queue in the same commit, before any later acquisition.
        stageClaimPromotion(ctx,owner,this.core.keyring);
        return ownedClaimView(updated, owner) as Json;
      } });
      wsPublisher.publish('agent_coordination.changed',{}); return result as ReturnType<typeof ownedClaimView>;
    }
    const result = await this.core.run(
      id,
      token,
      async (tx, session) => {
        const [claim] = await tx
          .select()
          .from(agentResourceClaims)
          .where(eq(agentResourceClaims.id, body.claim_id));
        if (!claim) throw new NotFoundError('Claim not found');
        if (session && (claim.sessionId !== id || claim.generation !== session.bindingGeneration))
          throw new ForbiddenError('Claim belongs to a different session binding');
        if (!session && !operatorId) throw new ForbiddenError('Operator required');
        const state = body.outcome === 'unknown' ? 'uncertain' : 'released';
        if (claim.state !== 'released') {
          await tx
            .update(agentResourceClaims)
            .set({ state, updatedAt: new Date().toISOString() })
            .where(eq(agentResourceClaims.id, claim.id));
          await this.announce(tx, claim.sessionId, {
            action: state,
            claim_id: claim.id,
            reason: body.reason,
            operator_id: operatorId,
          });
        }
        return { ...this.view(claim), state: claim.state === 'released' ? 'released' : state };
      },
      true,
    );
    wsPublisher.publish('agent_coordination.changed', {});
    return result;
  }
}

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
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
  acquireSchema,
  claimStatusSchema,
  CLAIM_SECONDS,
  NEGOTIATION_SECONDS,
  overlaps,
  type Resource,
} from './model.js';

type Claim = typeof agentResourceClaims.$inferSelect;
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
  async sweep(tx: AgentMessagingDb, sessions: AgentSession[]) {
    const claims = await tx.select().from(agentResourceClaims).where(eq(agentResourceClaims.state, 'active'));
    for (const claim of claims) {
      const owner = sessions.find((s) => s.id === claim.sessionId);
      if (
        !owner ||
        !this.core.present(owner) ||
        owner.bindingGeneration !== claim.generation ||
        Date.parse(claim.expiresAt) <= Date.now()
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
  async blockers(tx: AgentMessagingDb, resources: Resource[], exclude?: string) {
    const held = await tx
      .select()
      .from(agentResourceClaims)
      .where(inArray(agentResourceClaims.state, ['active', 'uncertain']));
    const blockers = held
      .filter(
        (c) =>
          c.id !== exclude && (c.resources as Resource[]).some((a) => resources.some((b) => overlaps(a, b))),
      )
      .map((c) => ({ id: c.id, session_id: c.sessionId, state: c.state }));
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
    const body = acquireSchema.parse(input);
    const result = await this.core.run(id, token, async (tx, session) => {
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
      const targetHosts = await tx
        .select({ id: hosts.id })
        .from(hosts)
        .where(
          and(
            inArray(
              hosts.id,
              body.resources.map((r) => r.host_id),
            ),
            isNull(hosts.internalRole),
          ),
        );
      if (body.resources.some((r) => !targetHosts.some((h) => h.id === r.host_id)))
        throw new NotFoundError('Target host not found');
      const blockers = await this.blockers(tx, body.resources);
      const now = new Date().toISOString();
      const claim: Claim = {
        id: randomUUID(),
        sessionId: id,
        generation: session!.bindingGeneration,
        requestId: body.client_request_id,
        purpose: body.purpose,
        resources: body.resources,
        state: blockers.length ? 'waiting' : 'active',
        blockers,
        repliedAt: null,
        expiresAt: new Date(Date.now() + CLAIM_SECONDS * 1000).toISOString(),
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
      for (const ownerId of new Set(blockers.map((b) => b.session_id))) {
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
    return this.core.run(
      id,
      token,
      async (tx, session) => {
        await this.core.reconcile(tx);
        const [claim] = await tx
          .select()
          .from(agentResourceClaims)
          .where(eq(agentResourceClaims.id, body.claim_id));
        if (!claim) throw new NotFoundError('Claim not found');
        if (body.response) {
          if (!(claim.blockers as Array<{ session_id: string }>).some((b) => b.session_id === id))
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
          const blockers = await this.blockers(tx, claim.resources as Resource[], claim.id);
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
          if (claim.state !== 'active')
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

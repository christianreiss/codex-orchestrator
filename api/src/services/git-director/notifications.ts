import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  adminEvents,
  agentBusAddresses,
  agentSessions,
  gitClones,
  gitMergeRequests,
  gitWorktrees,
  versions,
  type GitClone,
  type GitWorktree,
} from '../../db/schema.js';
import { ApiError } from '../../http/errors.js';
import type { Database } from '../../db/client.js';
import type { AgentMessagingService } from '../agent-messaging.js';
import type { AgentMessagingDb } from '../agent-messaging/types.js';
import { readWorkspace } from '../agent-messaging/workspace.js';
import { AGENT_PRESENCE_FRESH_SECONDS, deriveAddressPresence, isPresent } from '../agent-presence.js';
import { isoOffsetSeconds } from '../../util/timestamp.js';
import { isTruthyFlagValue } from '../settings.js';

export interface DirectorEvent {
  kind: string;
  clone?: GitClone;
  worktree?: GitWorktree;
  requestId?: string;
  targetBranch?: string | null;
  previousTargetBranch?: string | null;
  /** Repository information may cross clones; lease changes never do. */
  audience: 'repository' | 'branch' | 'owners' | 'active';
  ownerWorktrees?: GitWorktree[];
  includeActor?: boolean;
  detail?: Record<string, unknown>;
}

/** Persist notices in the caller's transaction: rollback also rolls back delivery.
 * The existing bus owns encryption, eligibility, session fencing and retries.
 */
export class GitDirectorNotifications {
  constructor(
    private readonly bus: Pick<AgentMessagingService, 'coordinationNotice'>,
    private readonly freshSeconds = AGENT_PRESENCE_FRESH_SECONDS,
  ) {}

  async enqueue(tx: AgentMessagingDb, event: DirectorEvent, now: string): Promise<string[]> {
    const [flag] = await tx.select().from(versions).where(eq(versions.name, 'agent_messaging_enabled'));
    if (!isTruthyFlagValue(flag?.version)) {
      await tx.insert(adminEvents).values({
        type: 'git_director.notifications',
        hostId: event.clone?.hostId ?? null,
        payload: { kind: event.kind, queued: 0, reason: 'messaging_disabled' },
        createdAt: now,
      });
      return [];
    }
    const connection = tx as Database;
    await connection.execute(sql`SAVEPOINT git_director_notices`);
    try {
      return await this.enqueueEnabled(tx, event, now);
    } catch (error) {
      // A deadlock aborts the entire MySQL transaction. Never claim that its
      // Git mutation survived; let the caller retry the real operation.
      const code =
        (error as { code?: string; cause?: { code?: string } }).cause?.code ??
        (error as { code?: string }).code;
      if (
        code !== 'ER_DUP_ENTRY' &&
        !(error instanceof ApiError && [400, 403, 404, 423, 503].includes(error.status))
      )
        throw error;
      await connection.execute(sql`ROLLBACK TO SAVEPOINT git_director_notices`);
      await tx.insert(adminEvents).values({
        type: 'git_director.notifications',
        hostId: event.clone?.hostId ?? null,
        payload: { kind: event.kind, queued: 0, reason: 'notification_failed', code: code ?? 'unknown' },
        createdAt: now,
      });
      return [];
    } finally {
      // Deadlocks already removed the savepoint; preserve the original error.
      await connection.execute(sql`RELEASE SAVEPOINT git_director_notices`).catch(() => {});
    }
  }

  private async enqueueEnabled(tx: AgentMessagingDb, event: DirectorEvent, now: string): Promise<string[]> {
    const relatedClones =
      event.clone && event.audience === 'repository' && event.clone.remoteKey
        ? await tx
            .select({ id: gitClones.id })
            .from(gitClones)
            .where(eq(gitClones.remoteKey, event.clone.remoteKey))
        : [];
    const cloneIds = event.clone ? [...new Set([event.clone.id, ...relatedClones.map((c) => c.id)])] : [];
    const worktrees = await tx
      .select()
      .from(gitWorktrees)
      .where(
        and(
          eq(gitWorktrees.status, 'active'),
          cloneIds.length ? inArray(gitWorktrees.cloneId, cloneIds) : undefined,
        ),
      );
    const requests = event.clone
      ? await tx.select().from(gitMergeRequests).where(eq(gitMergeRequests.cloneId, event.clone.id))
      : [];
    const targetBranch = event.targetBranch ?? event.worktree?.targetBranch;
    const waitingIds = new Set(
      requests
        .filter(
          (r) =>
            r.verdict === 'wait' &&
            !r.completedAt &&
            (!targetBranch ||
              r.targetBranch === targetBranch ||
              (event.previousTargetBranch !== undefined && r.targetBranch === event.previousTargetBranch)),
        )
        .map((r) => r.worktreeId),
    );
    const sessions = await tx
      .select({ session: agentSessions, address: agentBusAddresses })
      .from(agentSessions)
      .innerJoin(agentBusAddresses, eq(agentSessions.agentBusAddressId, agentBusAddresses.id))
      .where(
        and(
          isNull(agentSessions.endedAt),
          event.clone
            ? event.audience === 'repository' && event.clone.remoteKey
              ? or(
                  eq(agentSessions.hostId, event.clone.hostId),
                  sql`JSON_UNQUOTE(JSON_EXTRACT(${agentSessions.workspace}, '$.repository_key')) = ${event.clone.remoteKey}`,
                )
              : eq(agentSessions.hostId, event.clone.hostId)
            : undefined,
        ),
      );
    const ids: string[] = [];
    let skipped = 0;
    const eventId = randomUUID();
    const [audit] = await tx
      .insert(adminEvents)
      .values({
        type: 'git_director.notifications',
        hostId: event.clone?.hostId ?? null,
        payload: { event_id: eventId, kind: event.kind, queued: 0 },
        createdAt: now,
      })
      .$returningId();
    for (const { session, address } of sessions) {
      if (
        address.currentSessionId !== session.id ||
        !isPresent(
          deriveAddressPresence(address, session, isoOffsetSeconds(-this.freshSeconds, new Date(now))),
        )
      )
        continue;
      const workspace = readWorkspace(session.workspace);
      const root = workspace?.git_root ?? workspace?.cwd ?? session.cwd;
      const own = worktrees.filter(
        (w) => w.agentBusAddressId === address.id || (w.hostId === session.hostId && w.worktreePath === root),
      );
      const bound = (w: GitWorktree) =>
        w.agentSessionId === session.id &&
        w.agentBindingGeneration === session.bindingGeneration &&
        address.bindingGeneration === session.bindingGeneration;
      const actor = event.worktree && bound(event.worktree);
      const owner = event.ownerWorktrees?.some((w) => w.agentBusAddressId === address.id && bound(w));
      const sameClone = Boolean(
        event.clone &&
        session.hostId === event.clone.hostId &&
        (workspace?.git_common_dir === event.clone.cloneDir ||
          own.some((w) => w.cloneId === event.clone!.id)),
      );
      const informationalActor =
        event.worktree && session.hostId === event.worktree.hostId && root === event.worktree.worktreePath;
      if ((actor || informationalActor) && !event.includeActor) continue;
      const affectedWaiter = sameClone && own.some((w) => waitingIds.has(w.id) && bound(w));
      const selected =
        (event.includeActor && actor) ||
        owner ||
        (event.audience === 'repository'
          ? // Routine repository bookkeeping remains in audit/WS/poll. Only a
            // current, exactly bound waiting request needs a native recheck.
            affectedWaiter
          : event.audience === 'branch'
            ? sameClone && own.some((w) => waitingIds.has(w.id) && bound(w))
            : event.audience === 'active'
              ? false // Global module bookkeeping is audit/WS/poll only.
              : false);
      if (!selected) continue;
      const detail =
        JSON.stringify(event.detail ?? {}).length <= 12000 ? event.detail : { details_omitted: true };
      const content = `GIT-DIRECTOR/1\nInformational state change, not work authorization or a merge lease. Revalidate with git_list/git_merge_status and current local Git state before acting. Never infer merge success, lease revocation or exclusivity from a notice. No acknowledgement required.\n${JSON.stringify({ event_id: eventId, revision: audit!.id, observed_at: now, kind: event.kind, clone_id: event.clone?.id, worktree_id: event.worktree?.id, request_id: event.requestId, target_branch: event.targetBranch, ...detail })}`;
      const id = await this.bus.coordinationNotice(tx, session, content, false, undefined, {
        deliveryClass: [
          'lease_expired',
          'operator_eviction',
          'operator_decision',
          'registration_superseded',
          'registration_rebound',
        ].includes(event.kind)
          ? 'coordination'
          : 'notice',
        ttlSeconds: event.audience === 'repository' ? 3600 : 900,
      });
      if (id) ids.push(id);
      else skipped++;
    }
    await tx
      .update(adminEvents)
      .set({
        payload: {
          event_id: eventId,
          kind: event.kind,
          queued: ids.length,
          skipped,
          unbound_registrations: worktrees.filter(
            (w) =>
              (!event.clone || w.cloneId === event.clone.id) &&
              (!w.agentSessionId || w.agentBindingGeneration == null),
          ).length,
        },
      })
      .where(eq(adminEvents.id, audit!.id));
    return ids;
  }
}

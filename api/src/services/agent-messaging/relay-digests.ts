import { and, asc, eq, exists, inArray, isNull, lte, or } from 'drizzle-orm';
import { alias, type AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import { agentBusMessages } from '../../db/schema.js';
import { nowIso } from '../../util/timestamp.js';
import type { AgentMessagingDb } from './types.js';

// Leased roots are deliberately excluded. claimDelivery reconciles an expired
// lease before recovery; an active or uncertain presentation must never replay.
const states = ['queued', 'expired', 'dead', 'canceled'];
type RootColumns = Record<'kind' | 'status' | 'acceptedAt' | 'presentedAt' | 'ambiguousAt', AnyMySqlColumn>;
function restorable(root: RootColumns) {
  return and(
    eq(root.kind, 'digest'),
    inArray(root.status, states),
    isNull(root.acceptedAt),
    isNull(root.presentedAt),
    isNull(root.ambiguousAt),
  );
}

/** A terminal digest can leave only batched originals, so ordinary queue peeks miss it. */
export function relayDigestRecoveryPending(db: AgentMessagingDb) {
  const root = alias(agentBusMessages, 'relay_restore_root');
  return and(
    eq(agentBusMessages.status, 'batched'),
    exists(
      db
        .select({ id: root.id })
        .from(root)
        .where(
          and(
            eq(root.id, agentBusMessages.digestId),
            eq(root.targetAddressId, agentBusMessages.targetAddressId),
            restorable(root),
          ),
        ),
    ),
  );
}

/** Caller holds the bus gate and the dormant target address lock. Keep every original and the root tombstone. */
export async function restoreRelayDigests(tx: AgentMessagingDb, targetId: string) {
  const now = nowIso();
  const member = alias(agentBusMessages, 'relay_restore_member');
  const roots = await tx
    .select()
    .from(agentBusMessages)
    .where(
      and(
        eq(agentBusMessages.targetAddressId, targetId),
        restorable(agentBusMessages),
        or(
          eq(agentBusMessages.status, 'queued'),
          exists(
            tx
              .select({ id: member.id })
              .from(member)
              .where(
                and(
                  eq(member.digestId, agentBusMessages.id),
                  eq(member.targetAddressId, targetId),
                  eq(member.status, 'batched'),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(agentBusMessages.dispatchOrder))
    .for('update');
  for (const root of roots) {
    if (root.status === 'queued')
      await tx
        .update(agentBusMessages)
        .set({ status: 'canceled', canceledAt: now, leaseUntil: null, updatedAt: now })
        .where(eq(agentBusMessages.id, root.id));
    const members = and(
      eq(agentBusMessages.targetAddressId, targetId),
      eq(agentBusMessages.digestId, root.id),
      eq(agentBusMessages.status, 'batched'),
    );
    await tx
      .update(agentBusMessages)
      .set({ status: 'expired', expiredAt: now, updatedAt: now })
      .where(and(members, lte(agentBusMessages.expiresAt, now)));
    await tx
      .update(agentBusMessages)
      .set({ status: 'queued', digestId: null, updatedAt: now })
      .where(members);
  }
}

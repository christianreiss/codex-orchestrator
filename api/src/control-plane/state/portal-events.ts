import { appendCompanionEvent } from './companion-index.js';
import { recordAssistantResponse } from './messaging-totals.js';
import { agentEvents } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import type { OwnerMutationContext } from './runtime.js';

/** Cold event body and bounded metadata become visible in the same commit. */
export function stagePortalEvent(
  context: OwnerMutationContext,
  input: typeof agentEvents.$inferInsert,
  options: { once?: boolean } = {},
): { id: number } {
  const result = { id: 0 };
  context.write(async (tx) => {
    // A resumed lifecycle can abandon again. Its durable marker remains valid;
    // reusing it must neither fail reconciliation nor rewind the event cursor.
    // Owner commands serialize this check and insert in the same transaction.
    if (options.once && input.clientEventId) {
      const [existing] = await tx
        .select({ id: agentEvents.id })
        .from(agentEvents)
        .where(and(eq(agentEvents.sessionId, input.sessionId), eq(agentEvents.clientEventId, input.clientEventId)))
        .limit(1);
      if (existing) {
        result.id = existing.id;
        return;
      }
    }
    const [inserted] = await tx.insert(agentEvents).values(input);
    result.id = Number(inserted.insertId);
    recordAssistantResponse(context.draft, input);
    if (!Number.isSafeInteger(result.id) || result.id < 1) throw new Error('Invalid portal event cursor');
    const session = context.draft.table('agentSessions').get(input.sessionId);
    if (session)
      context.draft.upsert('agentSessions', {
        ...session,
        companionEvents: appendCompanionEvent(session.companionEvents, input.eventType, result.id),
        portalEventCursor: result.id,
        portalLastEventType: input.eventType,
        portalLastEventAt: input.createdAt,
        ...(input.eventType === 'message_accepted' ? { portalAcceptedAt: input.createdAt } : {}),
        ...(input.eventType === 'attention' ? { portalAttentionCursor: result.id } : {}),
        ...(['user_message', 'close_requested', 'attention_resolved'].includes(input.eventType)
          ? { portalAttentionClearedCursor: result.id }
          : {}),
      });
    context.draft.upsert('versions', {
      name: 'owner_portal_event_id',
      version: String(result.id),
      updatedAt: input.createdAt,
    });
  });
  return result;
}

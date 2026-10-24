import { appendCompanionEvent } from './companion-index.js';
import { recordAssistantResponse } from './messaging-totals.js';
import { agentEvents } from '../../db/schema.js';
import type { OwnerMutationContext } from './runtime.js';

/** Cold event body and bounded metadata become visible in the same commit. */
export function stagePortalEvent(
  context: OwnerMutationContext,
  input: typeof agentEvents.$inferInsert,
): { id: number } {
  const result = { id: 0 };
  context.write(async (tx) => {
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

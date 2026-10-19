import { and, eq } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { agentEvents, type AgentSession } from '../db/schema.js';
import { ConflictError } from '../http/errors.js';

/** `client_event_id` of the event the portal's abandonment sweep writes before it ends a session. */
export const ABANDONED_SESSION_EVENT_ID = 'server:abandoned';

/**
 * The single `agent_session_finished` refusal for a bridge-authenticated call on
 * an ended lifecycle. The code is unchanged on purpose: wrappers latch it as
 * terminal, which is what stops a dead bridge from becoming a heartbeat loop or
 * a host-authenticated resurrection. Only the message changes, so the agent and
 * operator reading it learn the one recovery route that exists: an ended
 * lifecycle is never revived, but an exact resume of the same native
 * conversation in a new managed launch rebinds the same agent address (next
 * binding generation, native continuity) and needs no fresh-start approval.
 *
 * Only the cold refusal path pays for the event lookup.
 */
export async function agentSessionFinishedError(
  db: Pick<Database, 'select'>,
  session: Pick<AgentSession, 'id' | 'status'>,
): Promise<ConflictError> {
  const abandoned = session.status === 'failed' && (await db
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, session.id), eq(agentEvents.clientEventId, ABANDONED_SESSION_EVENT_ID)))
    .limit(1)).length > 0;
  const recovery = 'This managed lifecycle cannot be revived. To continue as the same agent, exit the CLI and resume the same native conversation in a new managed launch; the exact resume rebinds the same agent address without fresh-start approval.';
  return new ConflictError(
    abandoned
      ? `Agent session is finished: the server closed it as abandoned after its bridge lease lapsed without a heartbeat. ${recovery}`
      : `Agent session is finished. ${recovery}`,
    'agent_session_finished',
    { ended_reason: abandoned ? 'abandoned' : 'finished', recovery: 'resume_native_conversation' },
  );
}

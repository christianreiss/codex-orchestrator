import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentEvents } from '../../db/schema.js';
import { decrypt } from '../../security/secret-box.js';
import type { Keyring } from '../../security/keyring.js';

/** Fetch only the latest naming event for each peer on the returned page. */
export async function sessionTaskTitles(
  db: Pick<Database, 'select'>,
  keyring: Keyring,
  sessions: { id: string; upstreamSessionId: string | null }[],
) {
  const titles = new Map<string, string>();
  const owner = ownerRuntimeFor(db);
  if (owner) {
    owner.assertOwner();
    for (const session of sessions) {
      const current = owner.state.snapshot().sessions.get(session.id);
      if (current?.taskTitle && current.taskTitleNativeId === session.upstreamSessionId) titles.set(session.id, current.taskTitle);
    }
    return titles;
  }
  if (!sessions.length) return titles;
  const latest = db
    .select({ id: sql<number>`max(${agentEvents.id})`.as('latest_event_id') })
    .from(agentEvents)
    .where(
      and(
        inArray(
          agentEvents.sessionId,
          sessions.map((s) => s.id),
        ),
        eq(agentEvents.eventType, 'session_named'),
      ),
    )
    .groupBy(agentEvents.sessionId)
    .as('latest_names');
  const rows = await db
    .select({ sessionId: agentEvents.sessionId, payload: agentEvents.payloadEnc })
    .from(agentEvents)
    .innerJoin(latest, eq(agentEvents.id, latest.id));
  const nativeIds = new Map(sessions.map((s) => [s.id, s.upstreamSessionId]));
  for (const row of rows) {
    try {
      const naming = JSON.parse(decrypt(row.payload, keyring)) as Record<string, unknown>;
      if (naming.native_session_id === nativeIds.get(row.sessionId) && typeof naming.name === 'string')
        titles.set(row.sessionId, naming.name.slice(0, 160));
    } catch {
      /* A damaged optional title must not hide the peer. */
    }
  }
  return titles;
}

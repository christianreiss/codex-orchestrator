import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { companionUnread, COMPANION_EVENT_TYPES } from '../../control-plane/state/companion-index.js';
import { namedSessionTitle } from '../agent-messaging/names.js';
import { and, eq, gt, count, inArray, sql } from 'drizzle-orm';
import type { RouteContext } from '../../routes/index.js';
import { agentEvents, agentPrompts } from '../../db/schema.js';
import { decrypt } from '../../security/secret-box.js';

export function compactSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > 160 ? `${chars.slice(0, 159).join('').trimEnd()}…` : text;
}

export function eventSummary(type: string, payload: Record<string, unknown>): string {
  return (
    compactSummary(payload.summary) ??
    (type === 'waiting_input'
      ? 'Your reply is needed.'
      : type === 'attention'
        ? 'The agent needs your attention.'
        : 'New reply from the agent.')
  );
}

export function decodeSummaryPayload(
  payload: string,
  ctx: Pick<RouteContext, 'keyring'>,
): Record<string, unknown> {
  return JSON.parse(decrypt(payload, ctx.keyring)) as Record<string, unknown>;
}

/** Only enrich the companion's transcript-authorized projection. Never put text on the admin event bus. */
export async function companionPreviews(
  ctx: RouteContext,
  sessions: Array<Record<string, unknown>>,
  readCursors: Readonly<Record<string, number>> = {},
  aliases: ReadonlyMap<string, string> = new Map(),
): Promise<Array<Record<string, unknown>>> {
  if (!sessions.length) return sessions;
  const sessionIds = new Set(sessions.map((s) => String(s.id)));
  const physicalIds = [
    ...new Set([...sessionIds, ...[...aliases].filter(([, id]) => sessionIds.has(id)).map(([id]) => id)]),
  ];
  const logicalId = aliases.size
    ? sql<string>`CASE ${sql.join(
        [...aliases].map(
          ([physical, logical]) => sql`WHEN ${agentEvents.sessionId} = ${physical} THEN ${logical}`,
        ),
        sql` `,
      )} ELSE ${agentEvents.sessionId} END`
    : agentEvents.sessionId;
  const markers = Object.entries(readCursors)
    .filter(([sessionId, cursor]) => sessionIds.has(sessionId) && cursor > 0)
    .map(([sessionId, cursor]) => sql`WHEN ${logicalId} = ${sessionId} THEN ${cursor}`);
  const readCursor = markers.length ? sql`CASE ${sql.join(markers, sql` `)} ELSE 0 END` : sql`0`;
  const owner = ownerRuntimeFor(ctx.db);
  owner?.assertOwner();
  const snapshot = owner?.state.snapshot();
  const ownerLatest: Array<{ id: number; sessionId: string; type: string; unread: number }> = [];
  if (snapshot) {
    const byLogical = new Map<
      string,
      Map<string, { id: number; sessionId: string; type: string; unread: number }>
    >();
    for (const physical of physicalIds) {
      const index = snapshot.sessions.get(physical)?.companionEvents;
      if (!index) continue;
      const logical = aliases.get(physical) ?? physical,
        types = byLogical.get(logical) ?? new Map();
      byLogical.set(logical, types);
      let unread = companionUnread(index, Number(readCursors[logical] ?? 0));
      if (unread === undefined) {
        const [historical] = await ctx.db
          .select({ count: count() })
          .from(agentEvents)
          .where(
            and(
              eq(agentEvents.sessionId, physical),
              eq(agentEvents.eventType, 'assistant_message'),
              gt(agentEvents.id, Number(readCursors[logical] ?? 0)),
            ),
          );
        unread = Number(historical?.count ?? 0);
      }
      for (const type of COMPANION_EVENT_TYPES) {
        const id = index.heads[type];
        if (!id) continue;
        const previous = types.get(type);
        types.set(type, {
          id: Math.max(previous?.id ?? 0, id),
          sessionId: logical,
          type,
          unread: (previous?.unread ?? 0) + (type === 'assistant_message' ? unread : 0),
        });
      }
    }
    for (const types of byLogical.values()) ownerLatest.push(...types.values());
  }
  const latest = snapshot
    ? ownerLatest
    : await ctx.db
        .select({
          id: sql<number>`MAX(${agentEvents.id})`,
          sessionId: logicalId,
          type: agentEvents.eventType,
          unread: sql<number>`SUM(CASE WHEN ${agentEvents.eventType} = 'assistant_message' AND ${agentEvents.id} > ${readCursor} THEN 1 ELSE 0 END)`,
        })
        .from(agentEvents)
        .where(
          and(
            inArray(agentEvents.sessionId, physicalIds),
            inArray(agentEvents.eventType, [
              'assistant_message',
              'waiting_input',
              'attention',
              'session_named',
            ]),
          ),
        )
        .groupBy(logicalId, agentEvents.eventType);
  const unreadBySession = new Map(
    latest
      .filter((row) => row.type === 'assistant_message')
      .map((row) => [row.sessionId, Number(row.unread)]),
  );
  const promptIds = sessions.flatMap((s) =>
    s.pending_prompt ? [String((s.pending_prompt as { id: string }).id)] : [],
  );
  const prompts = promptIds.length
    ? snapshot
      ? promptIds.flatMap((id) => {
          const prompt = snapshot.table('agentPrompts').get(id);
          return prompt ? [{ id: prompt.id, eventId: prompt.eventId }] : [];
        })
      : await ctx.db
          .select({ id: agentPrompts.id, eventId: agentPrompts.eventId })
          .from(agentPrompts)
          .where(inArray(agentPrompts.id, promptIds))
    : [];
  const promptEvents = new Map(prompts.map((p) => [p.id, p.eventId]));
  const ids = [
    ...new Set([
      ...latest.map((r) => Number(r.id)),
      ...prompts.flatMap((p) => (p.eventId ? [p.eventId] : [])),
    ]),
  ];
  const rows = ids.length ? await ctx.db.select().from(agentEvents).where(inArray(agentEvents.id, ids)) : [];
  owner?.assertOwner();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bySession = new Map<string, Map<string, (typeof rows)[number]>>();
  for (const row of rows) {
    const id = aliases.get(row.sessionId) ?? row.sessionId;
    if (!bySession.has(id)) bySession.set(id, new Map());
    const events = bySession.get(id)!;
    if (row.id > (events.get(row.eventType)?.id ?? 0)) events.set(row.eventType, row);
  }
  return sessions.map((session) => {
    const events = bySession.get(String(session.id));
    const named = events?.get('session_named');
    const naming = named ? decodeSummaryPayload(named.payloadEnc, ctx) : null;
    const sessionName =
      naming && naming.native_session_id === (session.upstream_session_id ?? null)
        ? compactSummary(naming.name)
        : null;
    const card = {
      ...session,
      task_title: sessionName,
      session_name: namedSessionTitle(session.launch_name as string | null, sessionName),
    };
    // Preview priority can select an older prompt/attention event. Unread
    // replies need their own monotonic cursor, including retained ended chats.
    const replyCursor = Number(events?.get('assistant_message')?.id ?? 0);
    const unreadReplyCount = unreadBySession.get(String(session.id)) ?? 0;
    const prompt = session.pending_prompt as { id: string } | null;
    const type = prompt ? 'waiting_input' : session.attention ? 'attention' : 'assistant_message';
    const row =
      prompt && promptEvents.get(prompt.id) ? byId.get(promptEvents.get(prompt.id)!) : events?.get(type);
    if (!row)
      return { ...card, preview: null, reply_cursor: replyCursor, unread_reply_count: unreadReplyCount };
    const payload = decodeSummaryPayload(row.payloadEnc, ctx);
    // An older, still-open question must never inherit a newer question's summary.
    const summary = eventSummary(type, prompt && payload.prompt_id !== prompt.id ? {} : payload);
    return {
      ...card,
      preview: { summary, cursor: Number(row.id), created_at: row.createdAt },
      reply_cursor: replyCursor,
      unread_reply_count: unreadReplyCount,
    };
  });
}

export function notificationKind(
  type: string,
  followed: boolean,
  payload: Record<string, unknown> = {},
): 'attention' | 'reply' | null {
  if (payload.severity && ['assistant_message', 'waiting_input', 'attention'].includes(type))
    return 'attention';
  if (type === 'waiting_input' && payload.answer_mode) return followed ? 'reply' : null;
  if (type === 'waiting_input' || type === 'attention') return 'attention';
  return type === 'assistant_message' && followed ? 'reply' : null;
}

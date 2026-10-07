import { and, inArray, sql } from 'drizzle-orm';
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
): Promise<Array<Record<string, unknown>>> {
  if (!sessions.length) return sessions;
  const latest = await ctx.db
    .select({ id: sql<number>`MAX(${agentEvents.id})` })
    .from(agentEvents)
    .where(
      and(
        inArray(
          agentEvents.sessionId,
          sessions.map((s) => String(s.id)),
        ),
        inArray(agentEvents.eventType, ['assistant_message', 'waiting_input', 'attention']),
      ),
    )
    .groupBy(agentEvents.sessionId, agentEvents.eventType);
  const promptIds = sessions.flatMap((s) =>
    s.pending_prompt ? [String((s.pending_prompt as { id: string }).id)] : [],
  );
  const prompts = promptIds.length
    ? await ctx.db
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
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bySession = new Map<string, Map<string, (typeof rows)[number]>>();
  for (const row of rows) {
    if (!bySession.has(row.sessionId)) bySession.set(row.sessionId, new Map());
    const events = bySession.get(row.sessionId)!;
    if (row.id > (events.get(row.eventType)?.id ?? 0)) events.set(row.eventType, row);
  }
  return sessions.map((session) => {
    const events = bySession.get(String(session.id));
    const prompt = session.pending_prompt as { id: string } | null;
    const type = prompt ? 'waiting_input' : session.attention ? 'attention' : 'assistant_message';
    const row =
      prompt && promptEvents.get(prompt.id) ? byId.get(promptEvents.get(prompt.id)!) : events?.get(type);
    if (!row) return { ...session, preview: null };
    const payload = decodeSummaryPayload(row.payloadEnc, ctx);
    // An older, still-open question must never inherit a newer question's summary.
    const summary = eventSummary(type, prompt && payload.prompt_id !== prompt.id ? {} : payload);
    return { ...session, preview: { summary, cursor: Number(row.id), created_at: row.createdAt } };
  });
}

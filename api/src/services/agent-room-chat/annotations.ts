import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { agentRoomEvents, agentRoomPins, agentRoomReactions } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import { ApiError, ConflictError, NotFoundError } from '../../http/errors.js';

/**
 * Reactions and pins (migration 0119) annotate canonical room events only; room events
 * themselves are never edited or deleted. Both tables are cold: they are read straight
 * from the database in both storage modes and written in the caller's transaction (plain
 * mode) or through an owner command (owner mode), with an `agent_room_changes` row.
 */
export const MAX_ROOM_PINS = 20;
/** Distinct emoji per event, across all actors; one actor may add at most `MAX_OWN_REACTIONS`. */
export const MAX_EVENT_EMOJI = 20;
export const MAX_OWN_REACTIONS = 10;
export const MAX_EMOJI_BYTES = 16;

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const pictographic = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]️?⃣)/u;
/** Exactly one emoji grapheme (including ZWJ sequences, skin tones and flags), at most 16 UTF-8 bytes. */
export function isReactionEmoji(value: string): boolean {
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_EMOJI_BYTES) return false;
  if (/[\s\p{Cc}]/u.test(value)) return false;
  const parts = [...graphemes.segment(value)];
  return parts.length === 1 && pictographic.test(value);
}

const emoji = z
  .string()
  .refine(isReactionEmoji, 'Choose a single emoji (at most 16 bytes)');
export const roomReactionSchema = z
  .object({
    room_id: z.string().uuid(),
    event_id: z.string().uuid(),
    emoji,
    on: z.boolean(),
    client_request_id: z.string().uuid(),
  })
  .strict();
export const roomPinSchema = z
  .object({
    room_id: z.string().uuid(),
    event_id: z.string().uuid(),
    on: z.boolean(),
    client_request_id: z.string().uuid(),
  })
  .strict();
export type RoomReactionInput = z.infer<typeof roomReactionSchema>;
export type RoomPinInput = z.infer<typeof roomPinSchema>;

export interface ReactionSummary {
  emoji: string;
  count: number;
  mine: boolean;
}
type Reader = Pick<Database, 'select'>;

/** Aggregate reactions per event: emoji in order of first use, with count and own flag. */
export async function reactionsFor(
  db: Reader,
  eventIds: readonly string[],
  actor: string,
): Promise<Map<string, ReactionSummary[]>> {
  const out = new Map<string, ReactionSummary[]>();
  if (!eventIds.length) return out;
  const rows = await db
    .select()
    .from(agentRoomReactions)
    .where(inArray(agentRoomReactions.eventId, [...new Set(eventIds)]));
  const byEvent = new Map<string, ReactionRow[]>();
  for (const row of rows) byEvent.set(row.eventId, [...(byEvent.get(row.eventId) ?? []), row]);
  for (const [id, list] of byEvent) out.set(id, summarizeReactions(list, actor));
  return out;
}

/** Attach `reactions` (possibly empty) to every event that is a canonical room event. */
export async function attachReactions<T extends { id: string; reactions?: ReactionSummary[] }>(
  db: Reader,
  events: T[],
  actor: string,
): Promise<void> {
  const map = await reactionsFor(
    db,
    events.map((e) => e.id),
    actor,
  );
  for (const event of events) event.reactions = map.get(event.id) ?? [];
}

/** Pinned event ids of a room, newest pin first. */
export async function pinnedIds(db: Reader, roomId: string): Promise<string[]> {
  const rows = await db
    .select({ eventId: agentRoomPins.eventId })
    .from(agentRoomPins)
    .where(eq(agentRoomPins.roomId, roomId))
    .orderBy(desc(agentRoomPins.pinnedAt), desc(agentRoomPins.eventId));
  return rows.map((r) => r.eventId);
}

export async function pinRows(db: Reader, roomId: string) {
  return db
    .select()
    .from(agentRoomPins)
    .where(eq(agentRoomPins.roomId, roomId))
    .orderBy(desc(agentRoomPins.pinnedAt), desc(agentRoomPins.eventId));
}

export async function eventReactions(db: Reader, eventId: string) {
  return db
    .select()
    .from(agentRoomReactions)
    .where(eq(agentRoomReactions.eventId, eventId))
    .orderBy(asc(agentRoomReactions.createdAt));
}

/** Reactions and pins apply to canonical events of this room only (not adapted legacy history). */
export async function requireRoomEvent(db: Reader, roomId: string, eventId: string) {
  const [row] = await db
    .select({ id: agentRoomEvents.id })
    .from(agentRoomEvents)
    .where(and(eq(agentRoomEvents.id, eventId), eq(agentRoomEvents.roomId, roomId)));
  if (!row) throw new NotFoundError('Message not found in this conversation', 'room_event_not_found');
}

type ReactionRow = typeof agentRoomReactions.$inferSelect;
export function summarizeReactions(rows: readonly ReactionRow[], actor: string): ReactionSummary[] {
  const list: ReactionSummary[] = [];
  for (const row of [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const found = list.find((r) => r.emoji === row.emoji);
    if (found) {
      found.count++;
      found.mine ||= row.actor === actor;
    } else list.push({ emoji: row.emoji, count: 1, mine: row.actor === actor });
  }
  return list;
}

/**
 * Set semantics: `on` ensures the actor's reaction exists, `!on` ensures it is absent.
 * A retry of an already applied toggle changes nothing, so no operation receipt is kept.
 */
export function planReaction(rows: readonly ReactionRow[], actor: string, body: RoomReactionInput, now: string) {
  const mine = rows.some((r) => r.actor === actor && r.emoji === body.emoji);
  if (body.on === mine) return { changed: false as const, after: [...rows] };
  if (!body.on)
    return {
      changed: true as const,
      remove: true as const,
      after: rows.filter((r) => !(r.actor === actor && r.emoji === body.emoji)),
    };
  if (rows.filter((r) => r.actor === actor).length >= MAX_OWN_REACTIONS)
    throw new ConflictError(`At most ${MAX_OWN_REACTIONS} of your reactions per message`, 'reaction_limit');
  if (!rows.some((r) => r.emoji === body.emoji) && new Set(rows.map((r) => r.emoji)).size >= MAX_EVENT_EMOJI)
    throw new ConflictError(`At most ${MAX_EVENT_EMOJI} different reactions per message`, 'reaction_limit');
  const insert: ReactionRow = { roomId: body.room_id, eventId: body.event_id, actor, emoji: body.emoji, createdAt: now };
  return { changed: true as const, insert, after: [...rows, insert] };
}

type PinRow = typeof agentRoomPins.$inferSelect;
export function planPin(rows: readonly PinRow[], actor: string, body: RoomPinInput, now: string) {
  const has = rows.some((r) => r.eventId === body.event_id);
  if (body.on === has) return { changed: false as const, after: [...rows] };
  if (!body.on)
    return { changed: true as const, remove: true as const, after: rows.filter((r) => r.eventId !== body.event_id) };
  if (rows.length >= MAX_ROOM_PINS)
    throw new ConflictError(`A conversation keeps at most ${MAX_ROOM_PINS} pinned messages`, 'room_pin_limit');
  const insert: PinRow = { roomId: body.room_id, eventId: body.event_id, pinnedBy: actor, pinnedAt: now };
  return { changed: true as const, insert, after: [insert, ...rows] };
}

export async function pinOf(db: Reader, roomId: string, eventId: string) {
  const [row] = await db
    .select()
    .from(agentRoomPins)
    .where(and(eq(agentRoomPins.roomId, roomId), eq(agentRoomPins.eventId, eventId)));
  return row;
}

/** Plain text snippet of at most `max` characters (whitespace collapsed). */
export function plainSnippet(text: string, max = 200): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : flat;
}

/**
 * In-process sliding-window limiter (per API process; a multi-process deployment
 * multiplies the bound). Keys are device or operator ids, never content.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly message: string,
  ) {}
  take(key: string, now = Date.now()): void {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      const retry = Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000));
      throw new ApiError(this.message, {
        status: 429,
        code: 'rate_limited',
        type: 'rate_limit_error',
        headers: { 'retry-after': String(retry) },
        extra: { retry_after_seconds: retry },
      });
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000)
      for (const [k, v] of this.hits) if (!v.some((t) => t > now - this.windowMs)) this.hits.delete(k);
  }
}

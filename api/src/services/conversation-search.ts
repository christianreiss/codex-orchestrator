import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { agentEvents, agentRoomEvents } from '../db/schema.js';
import { ForbiddenError, ServiceUnavailableError, ValidationError } from '../http/errors.js';
import { decrypt } from '../security/secret-box.js';
import type { Keyring } from '../security/keyring.js';

/**
 * Bounded conversation search (Android Companion R5 / admin web). There is no index:
 * each request scans at most `SEARCH_SCAN_LIMIT` of the newest events the caller may
 * read, decrypts them in memory and keeps case-insensitive substring matches. The scan
 * also stops after `SEARCH_TIME_BUDGET_MS`. Query text and content are never logged,
 * persisted or audited; only counts are.
 */
export const SEARCH_SCAN_LIMIT = 2000;
export const SEARCH_TIME_BUDGET_MS = 2000;
export const SEARCH_SNIPPET_CONTEXT = 60;
const BATCH = 200;
/** Direct-chat event types whose text is a conversation message. */
export const DIRECT_SEARCH_TYPES = ['user_message', 'assistant_message', 'waiting_input'] as const;

export const searchQuerySchema = z
  .object({
    q: z
      .string()
      .transform((v) => v.replace(/\s+/gu, ' ').trim())
      .pipe(z.string().min(2, 'Search for at least two characters').max(200)),
    scope: z.enum(['rooms', 'direct', 'all']).default('all'),
    room_id: z.string().uuid().optional(),
    cursor: z.string().max(600).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine((b) => !(b.room_id && b.scope === 'direct'), 'room_id narrows a room search');
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** Stream position: newest-first `(created_at, id)`; `null` = exhausted, absent = not started. */
type Position = { t: string; id: string } | null | undefined;
interface Cursor {
  s: SearchQuery['scope'];
  room?: string;
  r?: Position;
  d?: Position;
}
export interface SearchRoomSource {
  /** Readable rooms: id -> title. */
  rooms: ReadonlyMap<string, string>;
}
export interface SearchDirectSource {
  /** Readable portal sessions: physical session id -> conversation id and title. */
  sessions: ReadonlyMap<string, { conversationId: string; title: string }>;
}
export interface SearchHit {
  scope: 'room' | 'direct';
  conversation_key: string;
  conversation_id: string;
  title: string;
  /** Room event UUID, or the direct-chat event cursor as a decimal string. */
  event_id: string;
  /** Direct chats only: the numeric event cursor (`/companion/v1/agents/:id/events`). */
  event_cursor?: number;
  created_at: string;
  actor: string;
  author: string;
  snippet: string;
  /** UTF-16 code-unit offsets into `snippet` (JavaScript and Kotlin string indices). */
  highlights: Array<{ start: number; length: number }>;
}
export interface SearchResult {
  results: SearchHit[];
  next_cursor: string | null;
  truncated: boolean;
  scanned: number;
  scopes: Array<'rooms' | 'direct'>;
}

/** What the search route needs from the room and portal services. */
export interface SearchDeps {
  search: ConversationSearch;
  rooms: { searchRooms(actor: { adminId?: number; name?: string }, roomId?: string): Promise<Map<string, string> | null> };
  portal: {
    isEnabled(): Promise<boolean>;
    listAgentsSnapshot(): Promise<{ sessions: Array<Record<string, unknown>> }>;
  };
}

/**
 * Resolve the readable sources and run the scan. Rooms need `agent_messaging.reveal_content`
 * (the route floor); direct chats also need `agent_portal.reveal_transcript`. `scope=all`
 * searches the subset the caller holds and skips a disabled module; naming one scope
 * explicitly reports its permission (403) or disabled module (503).
 * `aliasesFor` maps a physical portal session id to the conversation id the client uses
 * (Companion remote sessions); it never widens visibility.
 */
export async function searchConversations(
  deps: SearchDeps,
  actor: { adminId: number; name?: string },
  query: SearchQuery,
  can: { rooms: boolean; direct: boolean },
  aliasesFor?: (sessions: Array<Record<string, unknown>>) => Promise<ReadonlyMap<string, string>>,
): Promise<SearchResult> {
  const wantRooms = query.scope !== 'direct',
    wantDirect = query.scope !== 'rooms' && !query.room_id;
  if ((query.scope === 'rooms' || query.room_id) && !can.rooms)
    throw new ForbiddenError('Searching rooms requires message content access');
  if (query.scope === 'direct' && !can.direct)
    throw new ForbiddenError('Searching direct chats requires transcript access');
  if (query.scope === 'all' && !can.rooms && !can.direct)
    throw new ForbiddenError('Searching conversations requires content access');
  const sources: { rooms?: SearchRoomSource; direct?: SearchDirectSource } = {};
  if (wantRooms && can.rooms) {
    const rooms = await deps.rooms.searchRooms(actor, query.room_id);
    if (rooms) sources.rooms = { rooms };
    else if (query.scope === 'rooms' || query.room_id)
      throw new ServiceUnavailableError('Agent Messaging is disabled', 'agent_messaging_disabled');
  }
  if (wantDirect && can.direct) {
    if (await deps.portal.isEnabled()) {
      const { sessions } = await deps.portal.listAgentsSnapshot();
      const aliases = aliasesFor ? await aliasesFor(sessions) : new Map<string, string>();
      sources.direct = {
        sessions: new Map(
          sessions.map((s) => {
            const id = String(s.id);
            const title =
              (typeof s.session_name === 'string' && s.session_name) ||
              (typeof s.launch_name === 'string' && s.launch_name) ||
              (typeof s.engine === 'string' ? `${s.engine} agent` : 'Agent');
            return [id, { conversationId: aliases.get(id) ?? id, title }];
          }),
        ),
      };
    } else if (query.scope === 'direct')
      throw new ServiceUnavailableError('Agent portal is disabled', 'agent_portal_disabled');
  }
  return deps.search.search(query, sources);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Snippet of ±`context` characters around the first match, with every match inside it. */
export function snippetFor(
  text: string,
  query: string,
  context = SEARCH_SNIPPET_CONTEXT,
): { snippet: string; highlights: Array<{ start: number; length: number }> } | null {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const pattern = new RegExp(escape(query), 'giu');
  const first = pattern.exec(flat);
  if (!first) return null;
  let start = Math.max(0, first.index - context),
    end = Math.min(flat.length, first.index + first[0].length + context);
  // Never split a surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(flat[start] ?? '')) start--;
  if (end < flat.length && /[\uDC00-\uDFFF]/u.test(flat[end] ?? '')) end++;
  const prefix = start > 0 ? '…' : '',
    body = flat.slice(start, end),
    suffix = end < flat.length ? '…' : '';
  const highlights: Array<{ start: number; length: number }> = [];
  const inner = new RegExp(escape(query), 'giu');
  for (let m = inner.exec(body); m; m = inner.exec(body)) {
    if (!m[0].length) break;
    highlights.push({ start: prefix.length + m.index, length: m[0].length });
  }
  return { snippet: prefix + body + suffix, highlights };
}

function decodeCursor(raw: string | undefined, query: SearchQuery): Cursor {
  if (!raw) return { s: query.scope, ...(query.room_id ? { room: query.room_id } : {}) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString());
  } catch {
    throw new ValidationError('Invalid search cursor', { param: 'cursor' });
  }
  const position = z.union([z.object({ t: z.string().max(100), id: z.string().max(64) }).strict(), z.null()]).optional();
  const cursor = z
    .object({ s: z.enum(['rooms', 'direct', 'all']), room: z.string().uuid().optional(), r: position, d: position })
    .strict()
    .safeParse(parsed);
  if (!cursor.success || cursor.data.s !== query.scope || cursor.data.room !== query.room_id)
    throw new ValidationError('Invalid search cursor', { param: 'cursor' });
  return cursor.data;
}
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

interface Row {
  t: string;
  id: string;
  hit: (q: string) => SearchHit | null;
}
interface Stream {
  key: 'r' | 'd';
  buffer: Row[];
  position: Position;
  done: boolean;
  fetch: (before: Position) => Promise<Row[]>;
}
type RoomEventRow = typeof agentRoomEvents.$inferSelect;
type DirectEventRow = typeof agentEvents.$inferSelect;
/** Newest-first pages strictly before `(t, id)`; the SQL implementation is `sqlSearchStore`. */
export interface SearchStore {
  roomEvents(roomIds: string[], before: { t: string; id: string } | undefined, limit: number): Promise<RoomEventRow[]>;
  directEvents(sessionIds: string[], before: { t: string; id: number } | undefined, limit: number): Promise<DirectEventRow[]>;
}
export function sqlSearchStore(db: Pick<Database, 'select'>): SearchStore {
  return {
    roomEvents: (ids, before, limit) =>
      db
        .select()
        .from(agentRoomEvents)
        .where(
          and(
            inArray(agentRoomEvents.roomId, ids),
            before
              ? or(
                  lt(agentRoomEvents.createdAt, before.t),
                  and(eq(agentRoomEvents.createdAt, before.t), lt(agentRoomEvents.id, before.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(agentRoomEvents.createdAt), desc(agentRoomEvents.id))
        .limit(limit),
    directEvents: (ids, before, limit) =>
      db
        .select()
        .from(agentEvents)
        .where(
          and(
            inArray(agentEvents.sessionId, ids),
            inArray(agentEvents.eventType, [...DIRECT_SEARCH_TYPES]),
            before
              ? or(
                  lt(agentEvents.createdAt, before.t),
                  and(eq(agentEvents.createdAt, before.t), lt(agentEvents.id, before.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(agentEvents.createdAt), desc(agentEvents.id))
        .limit(limit),
  };
}
const newer = (a: Row, b: Row) => a.t > b.t || (a.t === b.t && a.id > b.id);

export class ConversationSearch {
  private readonly store: SearchStore;
  constructor(
    db: Pick<Database, 'select'> | SearchStore,
    private readonly keyring: Keyring,
    private readonly now: () => number = Date.now,
  ) {
    this.store = 'roomEvents' in db ? db : sqlSearchStore(db);
  }

  async search(
    query: SearchQuery,
    sources: { rooms?: SearchRoomSource; direct?: SearchDirectSource },
  ): Promise<SearchResult> {
    const cursor = decodeCursor(query.cursor, query);
    const started = this.now();
    const streams: Stream[] = [];
    if (sources.rooms && cursor.r !== null) streams.push(this.roomStream(sources.rooms, cursor.r, query.room_id));
    if (sources.direct && cursor.d !== null) streams.push(this.directStream(sources.direct, cursor.d));
    const results: SearchHit[] = [];
    let scanned = 0,
      truncated = false;
    for (;;) {
      if (results.length >= query.limit) break;
      if (scanned >= SEARCH_SCAN_LIMIT || this.now() - started >= SEARCH_TIME_BUDGET_MS) {
        truncated = streams.some((s) => !s.done || s.buffer.length);
        break;
      }
      for (const stream of streams)
        if (!stream.buffer.length && !stream.done) {
          stream.buffer = await stream.fetch(stream.position);
          if (stream.buffer.length < BATCH) stream.done = true;
        }
      const live = streams.filter((s) => s.buffer.length);
      if (!live.length) break;
      const pick = live.reduce((best, s) => (newer(s.buffer[0]!, best.buffer[0]!) ? s : best));
      const row = pick.buffer.shift()!;
      pick.position = { t: row.t, id: row.id };
      scanned++;
      const hit = row.hit(query.q);
      if (hit) results.push(hit);
    }
    for (const s of streams) if (s.done && !s.buffer.length) s.position = null;
    const exhausted = streams.every((s) => s.position === null);
    const next: Cursor = { s: query.scope, ...(query.room_id ? { room: query.room_id } : {}) };
    for (const s of streams) next[s.key] = s.position;
    // Streams excluded from this request (no permission/disabled) stay excluded on resume.
    if (!sources.rooms || cursor.r === null) next.r = null;
    if (!sources.direct || cursor.d === null) next.d = null;
    return {
      results,
      next_cursor: exhausted ? null : encodeCursor(next),
      truncated,
      scanned,
      scopes: [...(sources.rooms ? ['rooms' as const] : []), ...(sources.direct ? ['direct' as const] : [])],
    };
  }

  private roomStream(source: SearchRoomSource, position: Position, roomId?: string): Stream {
    const ids = roomId ? (source.rooms.has(roomId) ? [roomId] : []) : [...source.rooms.keys()];
    return {
      key: 'r',
      buffer: [],
      position,
      done: !ids.length,
      fetch: async (before) => {
        const rows = await this.store.roomEvents(ids, before ?? undefined, BATCH);
        return rows.map((row) => ({
          t: row.createdAt,
          id: row.id,
          hit: (q: string) => {
            let body: { name?: unknown; content?: unknown };
            try {
              body = JSON.parse(decrypt(row.bodyEnc, this.keyring)) as typeof body;
            } catch {
              return null; // An undecryptable row is skipped, never reported.
            }
            if (typeof body.content !== 'string') return null;
            const match = snippetFor(body.content, q);
            if (!match) return null;
            return {
              scope: 'room' as const,
              conversation_key: `room:${row.roomId}`,
              conversation_id: row.roomId,
              title: source.rooms.get(row.roomId) ?? 'Conversation',
              event_id: row.id,
              created_at: row.createdAt,
              actor: row.actor,
              author: typeof body.name === 'string' ? body.name : row.actor,
              ...match,
            };
          },
        }));
      },
    };
  }

  /** Direct chats: ids are bigint cursors, compared numerically through a zero-padded key. */
  private directStream(source: SearchDirectSource, position: Position): Stream {
    const ids = [...source.sessions.keys()];
    const key = (id: number) => String(id).padStart(20, '0');
    return {
      key: 'd',
      buffer: [],
      position,
      done: !ids.length,
      fetch: async (before) => {
        const beforeId = before ? Number(before.id) : 0;
        if (before && (!Number.isSafeInteger(beforeId) || beforeId < 0))
          throw new ValidationError('Invalid search cursor', { param: 'cursor' });
        const rows = await this.store.directEvents(ids, before ? { t: before.t, id: beforeId } : undefined, BATCH);
        return rows.map((row) => ({
          t: row.createdAt,
          id: key(row.id),
          hit: (q: string) => {
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(decrypt(row.payloadEnc, this.keyring)) as Record<string, unknown>;
            } catch {
              return null;
            }
            const text = typeof payload.text === 'string' ? payload.text : typeof payload.question === 'string' ? payload.question : null;
            if (!text) return null;
            const match = snippetFor(text, q);
            if (!match) return null;
            const session = source.sessions.get(row.sessionId)!;
            const operator = row.eventType === 'user_message';
            return {
              scope: 'direct' as const,
              conversation_key: `agent:${session.conversationId}`,
              conversation_id: session.conversationId,
              title: session.title,
              event_id: String(row.id),
              event_cursor: row.id,
              created_at: row.createdAt,
              actor: operator ? 'operator' : 'agent',
              author: operator ? 'Operator' : session.title,
              ...match,
            };
          },
        }));
      },
    };
  }
}

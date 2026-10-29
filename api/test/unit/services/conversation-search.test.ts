import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationSearch,
  SEARCH_SCAN_LIMIT,
  SEARCH_TIME_BUDGET_MS,
  searchConversations,
  searchQuerySchema,
  snippetFor,
  type SearchStore,
} from '../../../src/services/conversation-search.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const keyring = testKeyring();
const ROOM_A = randomUUID(),
  ROOM_B = randomUUID(),
  SESSION = randomUUID();
const at = (n: number) => new Date(Date.UTC(2026, 9, 29, 10, 0, 0) + n * 1000).toISOString();

function roomRow(roomId: string, n: number, content: string) {
  return {
    id: randomUUID(),
    roomId,
    actor: 'admin:1',
    requestId: randomUUID(),
    payloadHash: 'x',
    bodyEnc: encrypt(JSON.stringify({ name: 'Operator', content, attachments: [], kind: 'chat' }), keyring),
    createdAt: at(n),
  };
}
function directRow(id: number, n: number, type: string, text: string, sessionId = SESSION) {
  return {
    id,
    sessionId,
    clientEventId: `e${id}`,
    eventType: type,
    source: 'test',
    payloadEnc: encrypt(JSON.stringify(type === 'waiting_input' ? { question: text } : { text }), keyring),
    createdAt: at(n),
  };
}
/** In-memory store honouring the newest-first `(created_at, id)` contract. */
function memoryStore(rooms: ReturnType<typeof roomRow>[], direct: ReturnType<typeof directRow>[]) {
  const store: SearchStore & { roomCalls: number; directCalls: number } = {
    roomCalls: 0,
    directCalls: 0,
    async roomEvents(ids, before, limit) {
      store.roomCalls++;
      return rooms
        .filter((r) => ids.includes(r.roomId))
        .filter((r) => !before || r.createdAt < before.t || (r.createdAt === before.t && r.id < before.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, limit);
    },
    async directEvents(ids, before, limit) {
      store.directCalls++;
      return direct
        .filter((r) => ids.includes(r.sessionId))
        .filter((r) => ['user_message', 'assistant_message', 'waiting_input'].includes(r.eventType))
        .filter((r) => !before || r.createdAt < before.t || (r.createdAt === before.t && r.id < before.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
        .slice(0, limit);
    },
  };
  return store;
}
const q = (input: Record<string, unknown>) => searchQuerySchema.parse(input);
const roomSource = { rooms: new Map([[ROOM_A, 'Release'], [ROOM_B, 'Ops']]) };
const directSource = { sessions: new Map([[SESSION, { conversationId: SESSION, title: 'Builder' }]]) };

describe('search snippets', () => {
  it('matches case-insensitively and returns UTF-16 highlight offsets into the snippet', () => {
    const text = `${'x'.repeat(100)} Deploy the RELEASE now, release again ${'y'.repeat(100)}`;
    const out = snippetFor(text, 'release')!;
    expect(out.snippet.startsWith('…')).toBe(true);
    expect(out.snippet.endsWith('…')).toBe(true);
    for (const h of out.highlights) expect(out.snippet.slice(h.start, h.start + h.length).toLowerCase()).toBe('release');
    expect(out.highlights).toHaveLength(2);
  });
  it('treats the query literally, collapses whitespace and never splits surrogate pairs', () => {
    expect(snippetFor('a+b (c)', '(c)')!.highlights).toEqual([{ start: 4, length: 3 }]);
    expect(snippetFor('line one\n\n  line two', 'one line')!.snippet).toBe('line one line two');
    const emoji = `${'😀'.repeat(40)}needle${'😀'.repeat(40)}`;
    const out = snippetFor(emoji, 'needle')!;
    expect(out.snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(snippetFor('nothing here', 'absent')).toBeNull();
  });
  it('validates the query: two to 200 characters, known scopes, room_id not with direct', () => {
    expect(() => q({ q: 'a' })).toThrow();
    expect(() => q({ q: 'x'.repeat(201) })).toThrow();
    expect(() => q({ q: 'ok', scope: 'everything' })).toThrow();
    expect(() => q({ q: 'ok', scope: 'direct', room_id: ROOM_A })).toThrow();
    expect(() => q({ q: 'ok', limit: '51' })).toThrow();
    expect(() => q({ q: 'ok', other: '1' })).toThrow();
    expect(q({ q: '  two  words ' })).toMatchObject({ q: 'two words', scope: 'all', limit: 20 });
  });
});

describe('bounded conversation search', () => {
  it('merges rooms and direct chats newest first and pages by cursor without gaps', async () => {
    const rooms = [roomRow(ROOM_A, 1, 'deploy one'), roomRow(ROOM_B, 3, 'deploy three'), roomRow(ROOM_A, 5, 'other')];
    const direct = [
      directRow(10, 2, 'user_message', 'Deploy two'),
      directRow(11, 4, 'assistant_message', 'deploy four'),
      directRow(12, 6, 'progress', 'deploy progress is not a message'),
      directRow(13, 7, 'waiting_input', 'Deploy now?'),
    ];
    const search = new ConversationSearch(memoryStore(rooms, direct), keyring);
    const first = await search.search(q({ q: 'deploy', limit: '2' }), { rooms: roomSource, direct: directSource });
    expect(first.results.map((r) => r.snippet)).toEqual(['Deploy now?', 'deploy four']);
    expect(first.results[0]).toMatchObject({
      scope: 'direct',
      conversation_key: `agent:${SESSION}`,
      event_id: '13',
      event_cursor: 13,
      author: 'Builder',
      actor: 'agent',
    });
    expect(first.truncated).toBe(false);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await search.search(q({ q: 'deploy', limit: '2', cursor: first.next_cursor! }), {
      rooms: roomSource,
      direct: directSource,
    });
    expect(second.results.map((r) => r.snippet)).toEqual(['deploy three', 'Deploy two']);
    expect(second.results[0]).toMatchObject({ scope: 'room', conversation_key: `room:${ROOM_B}`, title: 'Ops' });
    expect(second.results[1]).toMatchObject({ actor: 'operator', author: 'Operator' });
    const third = await search.search(q({ q: 'deploy', limit: '2', cursor: second.next_cursor! }), {
      rooms: roomSource,
      direct: directSource,
    });
    expect(third.results.map((r) => r.snippet)).toEqual(['deploy one']);
    expect(third.next_cursor).toBeNull();
  });
  it('narrows to one room and rejects a cursor from another query shape', async () => {
    const rooms = [roomRow(ROOM_A, 1, 'alpha'), roomRow(ROOM_B, 2, 'alpha')];
    const search = new ConversationSearch(memoryStore(rooms, []), keyring);
    const one = await search.search(q({ q: 'alpha', scope: 'rooms', room_id: ROOM_A }), { rooms: roomSource });
    expect(one.results.map((r) => r.conversation_id)).toEqual([ROOM_A]);
    const page = await search.search(q({ q: 'alpha', scope: 'rooms', limit: '1' }), { rooms: roomSource });
    await expect(
      search.search(q({ q: 'alpha', scope: 'all', cursor: page.next_cursor! }), { rooms: roomSource }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(search.search(q({ q: 'alpha', cursor: 'not-json' }), { rooms: roomSource })).rejects.toMatchObject({
      status: 422,
    });
  });
  it(`stops after ${SEARCH_SCAN_LIMIT} scanned events, reports truncated and resumes from the scan position`, async () => {
    const rooms = Array.from({ length: SEARCH_SCAN_LIMIT + 50 }, (_, i) => roomRow(ROOM_A, i, i === 10 ? 'needle' : 'hay'));
    const search = new ConversationSearch(memoryStore(rooms, []), keyring);
    const first = await search.search(q({ q: 'needle', scope: 'rooms' }), { rooms: roomSource });
    expect(first).toMatchObject({ results: [], truncated: true, scanned: SEARCH_SCAN_LIMIT });
    const next = await search.search(q({ q: 'needle', scope: 'rooms', cursor: first.next_cursor! }), { rooms: roomSource });
    expect(next.results.map((r) => r.snippet)).toEqual(['needle']);
    expect(next.truncated).toBe(false);
    expect(next.next_cursor).toBeNull();
    expect(next.scanned).toBe(50);
  });
  it('honours the time budget', async () => {
    let clock = 0;
    const rooms = Array.from({ length: 30 }, (_, i) => roomRow(ROOM_A, i, 'hay'));
    const search = new ConversationSearch(memoryStore(rooms, []), keyring, () => (clock += SEARCH_TIME_BUDGET_MS / 10));
    const out = await search.search(q({ q: 'needle', scope: 'rooms' }), { rooms: roomSource });
    expect(out.truncated).toBe(true);
    expect(out.scanned).toBeLessThan(30);
    expect(out.next_cursor).toEqual(expect.any(String));
  });
  it('only scans the sources it was given', async () => {
    const store = memoryStore([roomRow(ROOM_A, 1, 'secret')], [directRow(1, 2, 'assistant_message', 'secret')]);
    const search = new ConversationSearch(store, keyring);
    const out = await search.search(q({ q: 'secret' }), { rooms: roomSource });
    expect(out.results.map((r) => r.scope)).toEqual(['room']);
    expect(out.scopes).toEqual(['rooms']);
    expect(store.directCalls).toBe(0);
    // Unreadable rooms are never queried.
    const none = await search.search(q({ q: 'secret', scope: 'rooms' }), { rooms: { rooms: new Map() } });
    expect(none.results).toEqual([]);
    expect(store.roomCalls).toBe(1);
  });
});

describe('search permissions and sources', () => {
  const deps = (enabled = { rooms: true, portal: true }) => {
    const store = memoryStore([roomRow(ROOM_A, 1, 'match')], [directRow(1, 2, 'assistant_message', 'match')]);
    return {
      search: new ConversationSearch(store, keyring),
      rooms: { searchRooms: vi.fn(async () => (enabled.rooms ? new Map([[ROOM_A, 'Release']]) : null)) },
      portal: {
        isEnabled: vi.fn(async () => enabled.portal),
        listAgentsSnapshot: vi.fn(async () => ({ sessions: [{ id: SESSION, session_name: 'Builder', engine: 'claude' }] })),
      },
    };
  };
  const actor = { adminId: 7, name: 'Operator' };
  it('drops direct chats without transcript access and refuses an explicit direct search', async () => {
    const d = deps();
    const out = await searchConversations(d, actor, q({ q: 'match' }), { rooms: true, direct: false });
    expect(out.scopes).toEqual(['rooms']);
    expect(d.portal.listAgentsSnapshot).not.toHaveBeenCalled();
    await expect(
      searchConversations(d, actor, q({ q: 'match', scope: 'direct' }), { rooms: true, direct: false }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      searchConversations(d, actor, q({ q: 'match', scope: 'rooms' }), { rooms: false, direct: true }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(searchConversations(d, actor, q({ q: 'match' }), { rooms: false, direct: false })).rejects.toMatchObject({
      status: 403,
    });
  });
  it('skips a disabled module in scope=all and reports it for an explicit scope', async () => {
    const d = deps({ rooms: false, portal: false });
    const out = await searchConversations(d, actor, q({ q: 'match' }), { rooms: true, direct: true });
    expect(out).toMatchObject({ results: [], scopes: [], next_cursor: null });
    await expect(
      searchConversations(d, actor, q({ q: 'match', scope: 'rooms' }), { rooms: true, direct: true }),
    ).rejects.toMatchObject({ status: 503, code: 'agent_messaging_disabled' });
    await expect(
      searchConversations(d, actor, q({ q: 'match', scope: 'direct' }), { rooms: true, direct: true }),
    ).rejects.toMatchObject({ status: 503, code: 'agent_portal_disabled' });
  });
  it('passes the room filter to the access check and maps direct conversation ids through aliases', async () => {
    const d = deps();
    await searchConversations(d, actor, q({ q: 'match', room_id: ROOM_A }), { rooms: true, direct: true });
    expect(d.rooms.searchRooms).toHaveBeenCalledWith(actor, ROOM_A);
    expect(d.portal.listAgentsSnapshot).not.toHaveBeenCalled();
    const remote = randomUUID();
    const out = await searchConversations(d, actor, q({ q: 'match', scope: 'direct' }), { rooms: true, direct: true }, async () =>
      new Map([[SESSION, remote]]),
    );
    expect(out.results[0]).toMatchObject({ conversation_key: `agent:${remote}`, title: 'Builder' });
  });
});

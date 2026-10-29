/** Reactions, pins and message search for shared rooms (API migration 0119). Pure helpers. */
export interface ReactionSummary {
  emoji: string;
  count: number;
  mine: boolean;
}
export interface SearchHighlight {
  start: number;
  length: number;
}
export interface SearchHit {
  scope: "room" | "direct";
  conversation_key: string;
  conversation_id: string;
  title: string;
  event_id: string;
  event_cursor?: number;
  created_at: string;
  actor: string;
  author: string;
  snippet: string;
  highlights: SearchHighlight[];
}
export interface SearchPage {
  results: SearchHit[];
  next_cursor: string | null;
  truncated: boolean;
  scanned: number;
  scopes: Array<"rooms" | "direct">;
}
export interface PinnedEntry {
  event_id: string;
  pinned_by: string;
  pinned_at: string;
  event: {
    id: string;
    created_at: string;
    actor: string;
    name: string;
    kind: string;
    snippet: string;
    attachments: number;
  } | null;
}
/** Quick picks offered by the web picker; the server accepts any single emoji. */
export const QUICK_REACTIONS = ["👍", "❤️", "😄", "🎉", "👀", "✅", "❌", "🚀"] as const;
export const MAX_ROOM_PINS = 20;
export const SEARCH_ROOT = "/admin/agent-messaging/search";

/** Split a snippet into plain and highlighted runs; tolerates overlapping or out-of-range offsets. */
export function highlightSegments(
  snippet: string,
  highlights: readonly SearchHighlight[],
): Array<{ text: string; mark: boolean }> {
  const out: Array<{ text: string; mark: boolean }> = [];
  let at = 0;
  for (const h of [...highlights].sort((a, b) => a.start - b.start)) {
    const start = Math.max(at, Math.min(snippet.length, h.start));
    const end = Math.max(start, Math.min(snippet.length, h.start + h.length));
    if (start > at) out.push({ text: snippet.slice(at, start), mark: false });
    if (end > start) out.push({ text: snippet.slice(start, end), mark: true });
    at = end;
  }
  if (at < snippet.length) out.push({ text: snippet.slice(at), mark: false });
  return out;
}

export function searchPath(params: {
  q: string;
  scope: "all" | "rooms" | "direct";
  roomId?: string;
  cursor?: string | null;
  limit?: number;
}): string {
  const query = new URLSearchParams({ q: params.q.trim(), scope: params.scope });
  if (params.roomId) query.set("room_id", params.roomId);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit) query.set("limit", String(params.limit));
  return `${SEARCH_ROOT}?${query}`;
}

/** Optimistic local toggle; the server's `reactions` replace it on success. */
export function toggledReactions(list: readonly ReactionSummary[], emoji: string, on: boolean): ReactionSummary[] {
  const found = list.find((r) => r.emoji === emoji);
  if (on) {
    if (found?.mine) return [...list];
    return found
      ? list.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, mine: true } : r))
      : [...list, { emoji, count: 1, mine: true }];
  }
  if (!found?.mine) return [...list];
  return list
    .map((r) => (r.emoji === emoji ? { ...r, count: r.count - 1, mine: false } : r))
    .filter((r) => r.count > 0);
}

export function reactionLabel(r: ReactionSummary): string {
  const people = r.count === 1 ? "1 reaction" : `${r.count} reactions`;
  return `${r.emoji} ${people}${r.mine ? ", including yours. Remove yours" : ". Add yours"}`;
}

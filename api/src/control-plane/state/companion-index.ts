export const COMPANION_REPLY_INDEX_LIMIT = 256;
export const COMPANION_EVENT_TYPES = [
  'assistant_message',
  'waiting_input',
  'attention',
  'session_named',
] as const;
export type CompanionEventType = (typeof COMPANION_EVENT_TYPES)[number];
export interface CompanionEventIndex {
  heads: Partial<Record<CompanionEventType, number>>;
  assistantCount: number;
  recentAssistantIds: number[];
}
export const emptyCompanionEventIndex = (): CompanionEventIndex => ({
  heads: {},
  assistantCount: 0,
  recentAssistantIds: [],
});
export function appendCompanionEvent(
  previous: CompanionEventIndex,
  type: string,
  id: number,
): CompanionEventIndex {
  if (!COMPANION_EVENT_TYPES.includes(type as CompanionEventType)) return previous;
  const heads = { ...previous.heads, [type]: Math.max(previous.heads[type as CompanionEventType] ?? 0, id) };
  if (type !== 'assistant_message') return { ...previous, heads };
  if (id <= (previous.heads.assistant_message ?? 0)) throw new Error('Companion reply cursor must advance');
  return {
    heads,
    assistantCount: previous.assistantCount + 1,
    recentAssistantIds: [...previous.recentAssistantIds, id].slice(-COMPANION_REPLY_INDEX_LIMIT),
  };
}
/** Undefined means the caller explicitly requested an older historical read position. */
export function companionUnread(index: CompanionEventIndex, cursor: number): number | undefined {
  if (cursor <= 0) return index.assistantCount;
  if (cursor >= (index.heads.assistant_message ?? 0)) return 0;
  const ids = index.recentAssistantIds;
  if (index.assistantCount === ids.length || (ids.length && cursor >= ids[0]!))
    return ids.filter((id) => id > cursor).length;
  return undefined;
}

import { describe, it, expect } from 'vitest';
import {
  appendCompanionEvent,
  companionUnread,
  emptyCompanionEventIndex,
  COMPANION_REPLY_INDEX_LIMIT,
} from '../src/control-plane/state/companion-index.js';
describe('bounded companion unread metadata', () => {
  it('answers exact current and recent cursors while requesting cold history for older partial positions', () => {
    let index = emptyCompanionEventIndex();
    for (let id = 1; id <= 300; id++) index = appendCompanionEvent(index, 'assistant_message', id * 2);
    expect(index.recentAssistantIds).toHaveLength(COMPANION_REPLY_INDEX_LIMIT);
    expect(companionUnread(index, 0)).toBe(300);
    expect(companionUnread(index, 600)).toBe(0);
    expect(companionUnread(index, 599)).toBe(1);
    expect(companionUnread(index, 90)).toBe(255);
    expect(companionUnread(index, 89)).toBeUndefined();
    const prior = index;
    index = appendCompanionEvent(index, 'waiting_input', 601);
    expect(index.heads.waiting_input).toBe(601);
    expect(index.assistantCount).toBe(300);
    expect(prior.heads.waiting_input).toBeUndefined();
  });
  it('counts gaps without treating event sequence as a reply count', () => {
    let index = appendCompanionEvent(emptyCompanionEventIndex(), 'assistant_message', 8);
    index = appendCompanionEvent(index, 'assistant_message', 20);
    expect(companionUnread(index, 1)).toBe(2);
    expect(companionUnread(index, 8)).toBe(1);
    expect(() => appendCompanionEvent(index, 'assistant_message', 20)).toThrow('advance');
  });
});

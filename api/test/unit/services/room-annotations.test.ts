import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isReactionEmoji,
  MAX_EVENT_EMOJI,
  MAX_OWN_REACTIONS,
  MAX_ROOM_PINS,
  planPin,
  planReaction,
  roomReactionSchema,
  SlidingWindowLimiter,
  summarizeReactions,
} from '../../../src/services/agent-room-chat/annotations.js';
import { ApiError, ConflictError } from '../../../src/http/errors.js';

const room = randomUUID(),
  event = randomUUID(),
  now = '2026-10-29T10:00:00.000Z';
const body = (emoji: string, on = true) => ({ room_id: room, event_id: event, emoji, on, client_request_id: randomUUID() });
const row = (actor: string, emoji: string, createdAt = now) => ({ roomId: room, eventId: event, actor, emoji, createdAt });

describe('reaction emoji validation', () => {
  it.each(['👍', '❤️', '🎉', '👍🏽', '👩‍💻', '🏳️‍🌈', '🇩🇪', '✅', '1️⃣'])('accepts the single emoji %s', (emoji) => {
    expect(isReactionEmoji(emoji)).toBe(true);
    expect(roomReactionSchema.safeParse(body(emoji)).success).toBe(true);
  });
  it.each(['', 'a', 'ok', '👍👍', ' 👍', '👍 ', '\u0000', '<b>', '👨‍👩‍👧‍👦'])('rejects %j', (emoji) => {
    expect(isReactionEmoji(emoji)).toBe(false);
  });
  it('bounds the stored value to 16 UTF-8 bytes', () => {
    // A family ZWJ sequence is one grapheme but 25 bytes.
    expect(Buffer.byteLength('👨‍👩‍👧‍👦')).toBeGreaterThan(16);
    expect(roomReactionSchema.safeParse(body('👨‍👩‍👧‍👦')).success).toBe(false);
  });
  it('rejects unknown fields and non-UUID ids', () => {
    expect(roomReactionSchema.safeParse({ ...body('👍'), extra: 1 }).success).toBe(false);
    expect(roomReactionSchema.safeParse({ ...body('👍'), event_id: 'x' }).success).toBe(false);
  });
});

describe('reaction toggles', () => {
  it('uses set semantics and reports no change for an applied retry', () => {
    const first = planReaction([], 'admin:1', body('👍'), now);
    expect(first.changed).toBe(true);
    expect('insert' in first && first.insert).toMatchObject({ actor: 'admin:1', emoji: '👍', eventId: event });
    expect(planReaction(first.after, 'admin:1', body('👍'), now).changed).toBe(false);
    const off = planReaction(first.after, 'admin:1', body('👍', false), now);
    expect(off.changed && 'remove' in off).toBe(true);
    expect(off.after).toEqual([]);
    expect(planReaction([], 'admin:1', body('👍', false), now).changed).toBe(false);
  });
  it('aggregates counts in order of first use with the reader flag', () => {
    const rows = [row('admin:2', '🎉', '2026-10-29T10:00:02.000Z'), row('admin:1', '👍'), row('admin:2', '👍', '2026-10-29T10:00:01.000Z')];
    expect(summarizeReactions(rows, 'admin:1')).toEqual([
      { emoji: '👍', count: 2, mine: true },
      { emoji: '🎉', count: 1, mine: false },
    ]);
    expect(summarizeReactions(rows, 'admin:3').every((r) => !r.mine)).toBe(true);
  });
  it('limits own reactions and distinct emoji per event', () => {
    const pool = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '😚', '🙂', '🤗', '🤩'];
    const own = pool.slice(0, MAX_OWN_REACTIONS).map((e) => row('admin:1', e));
    expect(() => planReaction(own, 'admin:1', body(pool[MAX_OWN_REACTIONS]!), now)).toThrow(ConflictError);
    const many = pool.slice(0, MAX_EVENT_EMOJI).map((e, i) => row(`admin:${i + 10}`, e));
    expect(() => planReaction(many, 'admin:1', body(pool[MAX_EVENT_EMOJI]!), now)).toThrow(/different reactions/);
    // Joining an existing emoji is always possible.
    expect(planReaction(many, 'admin:1', body(pool[0]!), now).changed).toBe(true);
  });
});

describe('pins', () => {
  const pin = (eventId: string) => ({ roomId: room, eventId, pinnedBy: 'admin:1', pinnedAt: now });
  it('pins once, unpins, and keeps at most 20 per room', () => {
    const first = planPin([], 'admin:1', { room_id: room, event_id: event, on: true, client_request_id: randomUUID() }, now);
    expect(first.changed).toBe(true);
    expect(first.after.map((p) => p.eventId)).toEqual([event]);
    expect(planPin(first.after, 'admin:1', { room_id: room, event_id: event, on: true, client_request_id: randomUUID() }, now).changed).toBe(false);
    expect(planPin(first.after, 'admin:1', { room_id: room, event_id: event, on: false, client_request_id: randomUUID() }, now).after).toEqual([]);
    const full = Array.from({ length: MAX_ROOM_PINS }, () => pin(randomUUID()));
    expect(() => planPin(full, 'admin:1', { room_id: room, event_id: event, on: true, client_request_id: randomUUID() }, now)).toThrow(
      expect.objectContaining({ status: 409, code: 'room_pin_limit' }),
    );
    // Unpinning from a full room still works.
    expect(planPin(full, 'admin:1', { room_id: room, event_id: full[0]!.eventId, on: false, client_request_id: randomUUID() }, now).after).toHaveLength(MAX_ROOM_PINS - 1);
  });
});

describe('sliding window limiter', () => {
  it('rejects the request after the bound with 429 and a retry hint, per key', () => {
    const limit = new SlidingWindowLimiter(2, 60_000, 'slow down');
    limit.take('a', 0);
    limit.take('a', 1);
    let error: unknown;
    try {
      limit.take('a', 2);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', headers: { 'retry-after': '60' } });
    limit.take('b', 2);
    limit.take('a', 60_001);
  });
});

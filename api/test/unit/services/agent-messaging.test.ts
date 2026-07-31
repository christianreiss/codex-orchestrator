import { describe, expect, it } from 'vitest';

import {
  AGENT_MESSAGING_DEFAULT_TTL_SECONDS,
  AGENT_MESSAGING_MAX_BODY_BYTES,
  AGENT_MESSAGING_MAX_TTL_SECONDS,
  AGENT_MESSAGING_MIN_TTL_SECONDS,
  deliveryBackoffSeconds,
  normalizeAgentAlias,
  normalizeMessageBody,
  normalizeMessageTtl,
} from '../../../src/services/agent-messaging.js';

describe('agent messaging public policy', () => {
  it('accepts one-to-one text up to 32 KiB without an argv-sized surrogate', () => {
    expect(normalizeMessageBody(' hello ')).toBe(' hello ');
    expect(normalizeMessageBody('a'.repeat(AGENT_MESSAGING_MAX_BODY_BYTES))).toHaveLength(
      AGENT_MESSAGING_MAX_BODY_BYTES,
    );
    expect(() => normalizeMessageBody('')).toThrow(/must not be empty/i);
    expect(() => normalizeMessageBody('a'.repeat(AGENT_MESSAGING_MAX_BODY_BYTES + 1))).toThrow(
      /32 KiB/i,
    );
  });

  it('defaults queued work to 24 hours and accepts one minute through seven days', () => {
    expect(normalizeMessageTtl(undefined)).toBe(AGENT_MESSAGING_DEFAULT_TTL_SECONDS);
    expect(normalizeMessageTtl(AGENT_MESSAGING_MIN_TTL_SECONDS)).toBe(
      AGENT_MESSAGING_MIN_TTL_SECONDS,
    );
    expect(normalizeMessageTtl(AGENT_MESSAGING_MAX_TTL_SECONDS)).toBe(
      AGENT_MESSAGING_MAX_TTL_SECONDS,
    );
    expect(() => normalizeMessageTtl(AGENT_MESSAGING_MIN_TTL_SECONDS - 1)).toThrow(
      /between 60 and 604800/i,
    );
    expect(() => normalizeMessageTtl(AGENT_MESSAGING_MAX_TTL_SECONDS + 1)).toThrow(
      /between 60 and 604800/i,
    );
  });

  it('uses bounded retry timing without inventing product rate or queue limits', () => {
    expect([1, 2, 3, 4, 8, 12].map(deliveryBackoffSeconds)).toEqual([
      2,
      4,
      8,
      16,
      256,
      900,
    ]);
  });

  it('keeps aliases out of the canonical agent UUID namespace', () => {
    expect(normalizeAgentAlias('build-bot')).toBe('agent:build-bot');
    expect(() => normalizeAgentAlias('agent:123e4567-e89b-42d3-a456-426614174000')).toThrow(
      /reserved canonical address format/i,
    );
  });
});

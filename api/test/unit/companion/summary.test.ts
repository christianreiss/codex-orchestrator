import { describe, expect, it } from 'vitest';
import { compactSummary, eventSummary } from '../../../src/services/companion/summary.js';

describe('companion summary', () => {
  it('uses a supplied summary and never copies the full answer as a fallback', () => {
    expect(
      eventSummary('assistant_message', {
        summary: ' DNS fixed.\n Restart needs approval. ',
        text: 'full response',
      }),
    ).toBe('DNS fixed. Restart needs approval.');
    expect(eventSummary('assistant_message', { text: 'full response' })).toBe('New reply from the agent.');
    expect(eventSummary('waiting_input', {})).toBe('Your reply is needed.');
    expect(eventSummary('attention', {})).toBe('The agent needs your attention.');
  });
  it('limits Unicode text without breaking an emoji', () => {
    expect(compactSummary('😀'.repeat(160))).toBe('😀'.repeat(160));
    expect(compactSummary('😀'.repeat(161))).toBe(`${'😀'.repeat(159)}…`);
    expect(compactSummary(' \n ')).toBeNull();
    expect(compactSummary(null)).toBeNull();
  });
});

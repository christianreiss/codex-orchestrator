import { describe, expect, it } from 'vitest';
import { notificationKind } from '../../../src/services/companion/push.js';
describe('explicit agent-chat urgency', () => {
  it('keeps ordinary rich questions separate from Needs you', () => {
    expect(notificationKind('waiting_input', false, { answer_mode: 'buttons' })).toBeNull();
    expect(notificationKind('waiting_input', true, { answer_mode: 'text' })).toBe('reply');
  });
  it.each(['important', 'critical', 'blocker'])('alerts explicit %s even without following', (severity) => {
    for (const type of ['assistant_message', 'waiting_input', 'attention'])
      expect(notificationKind(type, false, { severity })).toBe('attention');
  });
  it('does not send a notification for resolution', () => {
    expect(notificationKind('attention_resolved', true)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { notificationKind } from '../../../src/services/companion/push.js';
import { normalizeEvent } from '../../../src/services/agent-portal.js';
describe('inline chat importance', () => {
  it.each([{ important: true }, { severity: 'blocker', notice_id: '00000000-0000-4000-8000-000000000001' }])('retains the original reply and follows ordinary notification preferences', (flag) => {
    const { payload } = normalizeEvent('assistant_message', { text: 'Review the change', reply_to: 21, ...flag });
    expect(payload).toEqual({ text: 'Review the change', important: true, reply_to: 21 });
    expect(notificationKind('assistant_message', false, payload)).toBeNull();
    expect(notificationKind('assistant_message', true, payload)).toBe('reply');
  });
});
describe('explicit agent-chat urgency', () => {
  it('keeps ordinary rich questions separate from Needs you', () => {
    expect(notificationKind('waiting_input', false, { answer_mode: 'buttons' })).toBeNull();
    expect(notificationKind('waiting_input', true, { answer_mode: 'text' })).toBe('reply');
  });
  it.each(['important', 'critical', 'blocker'])('applies normal follow preferences to historic %s payloads', (severity) => {
    for (const type of ['assistant_message', 'waiting_input', 'attention'])
      expect(notificationKind(type, false, { severity })).toBeNull();
  });
  it('does not send a notification for resolution', () => {
    expect(notificationKind('attention_resolved', true)).toBeNull();
  });
});

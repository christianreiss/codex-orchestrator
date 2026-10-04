import { describe, expect, it } from 'vitest';
import { companionBaseUrl } from '../../../src/services/companion/devices.js';
import { notificationKind } from '../../../src/services/companion/push.js';

describe('companion boundaries', () => {
  it('only pairs against a canonical HTTPS origin', () => {
    expect(companionBaseUrl('https://fleet.example/')).toBe('https://fleet.example');
    for (const url of [
      'http://fleet.example',
      'https://user:pass@fleet.example',
      'https://fleet.example/a',
      'https://fleet.example/#token',
      undefined,
    ])
      expect(() => companionBaseUrl(url)).toThrow();
  });
  it('notifies questions and attention, plus followed replies only', () => {
    expect(notificationKind('waiting_input', false)).toBe('attention');
    expect(notificationKind('attention', false)).toBe('attention');
    expect(notificationKind('assistant_message', false)).toBeNull();
    expect(notificationKind('assistant_message', true)).toBe('reply');
    for (const type of ['progress', 'started', 'resumed', 'user_message', 'attention_resolved'])
      expect(notificationKind(type, true)).toBeNull();
  });
});

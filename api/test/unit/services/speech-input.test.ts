import { describe, expect, it } from 'vitest';
import { resolveSpeechInput } from '../../../src/services/speech-input.js';
describe('speech input inheritance', () => {
  it('defaults on without persisted settings', () => expect(resolveSpeechInput(null, null)).toEqual({ enabled: true, global: true, override: null }));
  for (const global of ['true', 'false', null]) for (const override of ['true', 'false', null, '']) {
    it(`resolves global ${global} and engine ${override}`, () => {
      const expected = override === 'true' ? true : override === 'false' ? false : global !== 'false';
      expect(resolveSpeechInput(global, override).enabled).toBe(expected);
    });
  }
});

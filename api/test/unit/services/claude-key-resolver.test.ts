import { describe, it, expect } from 'vitest';
import { extractAnthropicApiKey } from '../../../src/services/claude-key-resolver.js';

describe('extractAnthropicApiKey', () => {
  it('reads Authorization: Bearer <key>', () => {
    expect(extractAnthropicApiKey({ authorization: 'Bearer sk-ant-abc' })).toBe('sk-ant-abc');
    expect(extractAnthropicApiKey({ authorization: 'bearer    sk-ant-xyz  ' })).toBe('sk-ant-xyz');
  });

  it('reads x-api-key: <key>', () => {
    expect(extractAnthropicApiKey({ 'x-api-key': 'sk-ant-aaa' })).toBe('sk-ant-aaa');
  });

  it('reads Authorization: x-api-key <key> (legacy)', () => {
    expect(extractAnthropicApiKey({ authorization: 'x-api-key sk-ant-bbb' })).toBe('sk-ant-bbb');
  });

  it('reads bare Authorization: <key> (legacy)', () => {
    expect(extractAnthropicApiKey({ authorization: 'sk-ant-ccc' })).toBe('sk-ant-ccc');
  });

  it('rejects Basic/Digest auth schemes', () => {
    expect(extractAnthropicApiKey({ authorization: 'Basic dXNlcjpwYXNz' })).toBeNull();
    expect(extractAnthropicApiKey({ authorization: 'Digest realm=foo' })).toBeNull();
  });

  it('prefers Authorization over x-api-key when both are present', () => {
    expect(
      extractAnthropicApiKey({
        authorization: 'Bearer sk-ant-from-bearer',
        'x-api-key': 'sk-ant-from-xkey',
      }),
    ).toBe('sk-ant-from-bearer');
  });

  it('returns null when no header is set', () => {
    expect(extractAnthropicApiKey({})).toBeNull();
    expect(extractAnthropicApiKey({ authorization: '   ' })).toBeNull();
  });

  it('handles array-form headers', () => {
    expect(extractAnthropicApiKey({ authorization: ['Bearer sk-ant-arr'] })).toBe('sk-ant-arr');
    expect(extractAnthropicApiKey({ 'x-api-key': ['sk-ant-xarr'] })).toBe('sk-ant-xarr');
  });
});

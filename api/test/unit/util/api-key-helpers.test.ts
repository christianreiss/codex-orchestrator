import { describe, expect, it } from 'vitest';
import { extractApiKey, generateApiKey, hashApiKey, parseBearer } from '../../../src/util/api-key-helpers.js';

describe('parseBearer', () => {
  it.each(['Bearer tok', 'bearer tok', 'BEARER   tok  ', 'Bearer\ttok'])('extracts the token from %j', (header) => {
    expect(parseBearer(header)).toBe('tok');
  });

  it('returns the raw trimmed value for a non-Bearer header', () => {
    expect(parseBearer('  raw-token  ')).toBe('raw-token');
    expect(parseBearer('Basic dXNlcjpwdw==')).toBe('Basic dXNlcjpwdw==');
    // The scheme match is anchored, so a leading space makes the whole header the value.
    expect(parseBearer(' Bearer tok')).toBe('Bearer tok');
  });

  it('takes the first element of an array header', () => {
    expect(parseBearer(['Bearer first', 'Bearer second'])).toBe('first');
    expect(parseBearer([' raw-first ', 'raw-second'])).toBe('raw-first');
  });

  it('returns null for undefined or empty headers', () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('')).toBeNull();
    expect(parseBearer([])).toBeNull();
    expect(parseBearer([''])).toBeNull();
  });
});

describe('extractApiKey', () => {
  it('prefers Authorization over X-Api-Key', () => {
    expect(extractApiKey({ authorization: 'Bearer auth-key', 'x-api-key': 'header-key' })).toBe('auth-key');
    // A non-Bearer Authorization wins too — the hazard routes/mcp/index.ts works
    // around so an operator token is never mistaken for a host identity.
    expect(extractApiKey({ authorization: 'operator-token', 'x-api-key': 'header-key' })).toBe('operator-token');
  });

  it('falls back to X-Api-Key when Authorization is absent or empty', () => {
    expect(extractApiKey({ 'x-api-key': '  header-key  ' })).toBe('header-key');
    expect(extractApiKey({ authorization: '', 'x-api-key': 'header-key' })).toBe('header-key');
    expect(extractApiKey({ authorization: '   ', 'x-api-key': 'header-key' })).toBe('header-key');
    expect(extractApiKey({ 'x-api-key': ['  first-key  ', 'second-key'] })).toBe('first-key');
  });

  it('returns null when neither header is usable', () => {
    expect(extractApiKey({})).toBeNull();
    expect(extractApiKey({ authorization: undefined, 'x-api-key': undefined })).toBeNull();
    expect(extractApiKey({ authorization: '   ', 'x-api-key': '   ' })).toBeNull();
    expect(extractApiKey({ 'x-api-key': [] })).toBeNull();
  });
});

describe('generateApiKey', () => {
  it('defaults to the sk-codex- prefix', () => {
    const { key, hash, prefix } = generateApiKey();
    expect(prefix).toBe('sk-codex-');
    expect(key.startsWith('sk-codex-')).toBe(true);
    expect(hash).toBe(hashApiKey(key));
  });

  it('produces a key with the given prefix hashed by hashApiKey', () => {
    const { key, hash, prefix } = generateApiKey('sk-session-');
    expect(prefix).toBe('sk-session-');
    expect(key.startsWith('sk-session-')).toBe(true);
    expect(key.length).toBeGreaterThan('sk-session-'.length);
    expect(hash).toBe(hashApiKey(key));
    expect(generateApiKey('sk-session-').key).not.toBe(key);
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HOST_AGENTS_EXTRA_MAX_BYTES,
  appendHostAgentsExtra,
  normalizeHostAgentsExtra,
  summarizeHostAgentsExtra,
} from '../../../src/services/host-agents-extra.js';
import { ValidationError } from '../../../src/http/errors.js';

describe('normalizeHostAgentsExtra', () => {
  it('trims, normalizes line endings and maps blank to null', () => {
    expect(normalizeHostAgentsExtra('  a\r\nb\rc  \n')).toBe('a\nb\nc');
    expect(normalizeHostAgentsExtra('')).toBeNull();
    expect(normalizeHostAgentsExtra(' \n\t ')).toBeNull();
    expect(normalizeHostAgentsExtra(null)).toBeNull();
    expect(normalizeHostAgentsExtra(undefined)).toBeNull();
  });

  it('caps the trimmed text in UTF-8 bytes, not characters', () => {
    expect(normalizeHostAgentsExtra('x'.repeat(HOST_AGENTS_EXTRA_MAX_BYTES))).toHaveLength(HOST_AGENTS_EXTRA_MAX_BYTES);
    expect(normalizeHostAgentsExtra(`  ${'x'.repeat(HOST_AGENTS_EXTRA_MAX_BYTES)}  `)).toHaveLength(HOST_AGENTS_EXTRA_MAX_BYTES);
    expect(() => normalizeHostAgentsExtra('x'.repeat(HOST_AGENTS_EXTRA_MAX_BYTES + 1))).toThrow(ValidationError);
    // 'ü' is two bytes: half the cap in characters already fills it.
    expect(() => normalizeHostAgentsExtra('ü'.repeat(HOST_AGENTS_EXTRA_MAX_BYTES / 2 + 1))).toThrow('the limit is 32768 bytes');
  });

  it('rejects non-strings and NUL bytes', () => {
    expect(() => normalizeHostAgentsExtra(42)).toThrow(ValidationError);
    expect(() => normalizeHostAgentsExtra({ text: 'x' })).toThrow(ValidationError);
    expect(() => normalizeHostAgentsExtra('a\u0000b')).toThrow('NUL');
  });
});

describe('appendHostAgentsExtra / summarizeHostAgentsExtra', () => {
  it('leaves the body untouched without instructions', () => {
    for (const agentsExtra of [null, undefined, '', '  ']) {
      expect(appendHostAgentsExtra('Body\n\n', { fqdn: 'h.example', agentsExtra })).toEqual({ body: 'Body\n\n', sha256: null });
    }
  });

  it('appends under a heading naming the host', () => {
    const out = appendHostAgentsExtra('Body\n\n', { fqdn: 'h.example', agentsExtra: 'Do X.' });
    expect(out.body).toBe('Body\n\n## Host-specific instructions (h.example)\n\nDo X.\n');
    expect(out.sha256).toBe(createHash('sha256').update('Do X.').digest('hex'));
  });

  it('summarizes size and digest for the admin API', () => {
    expect(summarizeHostAgentsExtra(null)).toEqual({ content: null, size_bytes: 0, sha256: null, max_bytes: HOST_AGENTS_EXTRA_MAX_BYTES });
    expect(summarizeHostAgentsExtra('ü')).toMatchObject({ content: 'ü', size_bytes: 2 });
  });
});

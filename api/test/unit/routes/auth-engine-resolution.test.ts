import { describe, expect, it } from 'vitest';
import { resolveAuthRequestEngine } from '../../../src/routes/auth/engine-resolution.js';

function request(query: Record<string, unknown> = {}, headers: Record<string, string | string[]> = {}) {
  return { query, headers } as Parameters<typeof resolveAuthRequestEngine>[0];
}

describe('resolveAuthRequestEngine', () => {
  it('uses body, query, header, wrapper user-agent, then Codex default', () => {
    expect(resolveAuthRequestEngine(request(), { engine: 'claude' })).toBe('claude');
    expect(resolveAuthRequestEngine(request({ engine: 'claude' }), {})).toBe('claude');
    expect(resolveAuthRequestEngine(request({}, { 'x-engine': 'claude' }), {})).toBe('claude');
    expect(resolveAuthRequestEngine(request({}, { 'user-agent': 'clx/wrapper-v2' }), {})).toBe('claude');
    expect(resolveAuthRequestEngine(request(), {})).toBe('codex');
  });

  it.each([
    [{ engine: '' }, {}, {}],
    [{ engine: 'other' }, {}, {}],
    [{ engine: 7 }, {}, {}],
    [{}, { engine: ['claude'] }, {}],
    [{}, { engine: 'other' }, { 'x-engine': 'claude' }],
  ])('rejects invalid explicit values', (payload, query, headers) => {
    expect(() => resolveAuthRequestEngine(request(query, headers), payload)).toThrow(
      /engine must be "codex" or "claude"/,
    );
  });
});

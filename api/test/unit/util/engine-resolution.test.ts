import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  assertEngineAllowed,
  engineFromStoredValue,
  isClaudeUserAgent,
  readEngineHint,
  resolveEngineHints,
  resolveRequestEngine,
} from '../../../src/util/engine-resolution.js';
import { parseEngine } from '../../../src/util/engine.js';

type Req = Pick<FastifyRequest, 'query' | 'headers'>;

function request(
  query: Record<string, unknown> = {},
  headers: Record<string, string | string[]> = {},
): Req {
  return { query, headers } as Req;
}

/**
 * The rule this file exists for: **a malformed explicit engine is never Codex.**
 *
 * `POST /mcp` read its header as `isEngine(h) ? h : ENGINE_CODEX`, so
 * `X-Engine: gemini` dispatched against Codex silently — while `/auth` rejected
 * the identical value. One fleet, two answers, and the difference only showed up
 * as state written under an engine nobody selected.
 */
describe('readEngineHint', () => {
  it('returns null only when the hint was not sent at all', () => {
    expect(readEngineHint({ source: 'engine', value: undefined })).toBeNull();
    expect(readEngineHint({ source: 'engine', value: null })).toBeNull();
  });

  it('accepts both engines and normalizes case and padding', () => {
    expect(readEngineHint({ source: 'engine', value: 'codex' })).toBe('codex');
    expect(readEngineHint({ source: 'engine', value: 'claude' })).toBe('claude');
    expect(readEngineHint({ source: 'engine', value: '  CLAUDE ' })).toBe('claude');
  });

  it.each([
    ['an unknown engine', 'gemini'],
    ['a near miss', 'clude'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a list', 'codex,claude'],
    ['a number', 7],
    ['an array', ['claude']],
    ['an object', { engine: 'claude' }],
    ['a boolean', true],
  ])('rejects %s rather than defaulting to Codex', (_label, value) => {
    expect(() => readEngineHint({ source: 'engine', value })).toThrow(
      /engine must be "codex" or "claude"/,
    );
  });

  it('names the source it rejected so the caller knows which one to fix', () => {
    expect(() => readEngineHint({ source: 'X-Engine', value: 'gemini' })).toThrow(
      /X-Engine must be/,
    );
  });
});

describe('resolveEngineHints', () => {
  it('returns null when nothing was supplied', () => {
    expect(resolveEngineHints([{ source: 'engine', value: undefined }])).toBeNull();
    expect(resolveEngineHints([])).toBeNull();
  });

  it('accepts agreeing hints from several sources', () => {
    expect(
      resolveEngineHints([
        { source: 'engine', value: 'claude' },
        { source: 'X-Engine', value: 'CLAUDE' },
      ]),
    ).toBe('claude');
  });

  it('rejects conflicting hints instead of letting precedence pick a winner', () => {
    expect(() =>
      resolveEngineHints([
        { source: 'engine', value: 'codex' },
        { source: 'X-Engine', value: 'claude' },
      ]),
    ).toThrow(/conflicting engine hints: engine=codex, X-Engine=claude/);
  });

  it('still rejects a malformed hint that arrives after a valid one', () => {
    expect(() =>
      resolveEngineHints([
        { source: 'engine', value: 'codex' },
        { source: 'X-Engine', value: 'gemini' },
      ]),
    ).toThrow(/X-Engine must be/);
  });
});

describe('resolveRequestEngine', () => {
  it('reads body, query, and header', () => {
    expect(resolveRequestEngine(request(), { engine: 'claude' }, {})).toBe('claude');
    expect(resolveRequestEngine(request({ engine: 'claude' }), undefined, {})).toBe('claude');
    expect(resolveRequestEngine(request({}, { 'x-engine': 'claude' }), undefined, {})).toBe(
      'claude',
    );
  });

  it('requires an engine when nothing resolves and no fallback is configured', () => {
    expect(() => resolveRequestEngine(request(), undefined, {})).toThrow(/engine is required/);
  });

  it('uses the configured fallback only when no hint was sent', () => {
    expect(resolveRequestEngine(request(), undefined, { fallback: 'codex' })).toBe('codex');
    expect(() =>
      resolveRequestEngine(request({ engine: 'gemini' }), undefined, { fallback: 'codex' }),
    ).toThrow(/engine must be/);
  });

  it('infers from the wrapper user-agent only when opted in and only with no hint', () => {
    const clx = request({}, { 'user-agent': 'clx/wrapper-v2' });
    expect(resolveRequestEngine(clx, undefined, { legacyUserAgentInference: true })).toBe('claude');
    // An explicit hint beats the user-agent, even a contradicting one.
    expect(
      resolveRequestEngine(
        request({ engine: 'codex' }, { 'user-agent': 'clx/wrapper-v2' }),
        undefined,
        { legacyUserAgentInference: true },
      ),
    ).toBe('codex');
    // Without the opt-in the user-agent is ignored entirely.
    expect(resolveRequestEngine(clx, undefined, { fallback: 'codex' })).toBe('codex');
  });

  it('resolves a single-engine host without a hint, and never past its enabled set', () => {
    expect(resolveRequestEngine(request(), undefined, { hostEngines: ['claude'] })).toBe('claude');
    expect(() =>
      resolveRequestEngine(request({ engine: 'codex' }), undefined, { hostEngines: ['claude'] }),
    ).toThrow(/engine codex is not enabled for this host/);
  });

  it('requires an explicit engine on a dual-engine host with no fallback', () => {
    expect(() =>
      resolveRequestEngine(request(), undefined, { hostEngines: ['codex', 'claude'] }),
    ).toThrow(/engine is required/);
  });

  it('does not let user-agent inference select a disabled engine', () => {
    expect(() =>
      resolveRequestEngine(request({}, { 'user-agent': 'clx/wrapper-v2' }), undefined, {
        legacyUserAgentInference: true,
        hostEngines: ['codex'],
      }),
    ).toThrow(/engine claude is not enabled for this host/);
  });
});

describe('isClaudeUserAgent', () => {
  it.each(['clx/wrapper-v2', 'Mozilla (clx)', 'clx', 'foo clx_1'])('matches %j', (ua) => {
    expect(isClaudeUserAgent(ua)).toBe(true);
  });

  it.each([undefined, '', 'cdx/wrapper-v2', 'clxx/1', 'myclx/1'])('does not match %j', (ua) => {
    expect(isClaudeUserAgent(ua)).toBe(false);
  });
});

describe('assertEngineAllowed', () => {
  it('permits anything when the host set is unknown or empty', () => {
    expect(() => assertEngineAllowed('claude', undefined)).not.toThrow();
    expect(() => assertEngineAllowed('claude', [])).not.toThrow();
  });

  it('rejects an engine outside the host set', () => {
    expect(() => assertEngineAllowed('claude', ['codex'])).toThrow(/not enabled for this host/);
  });
});

/**
 * A stored column is history, not a caller. It degrades rather than throwing —
 * a row this build cannot parse must not take a request down with it.
 */
describe('engineFromStoredValue', () => {
  it('reads valid stored values', () => {
    expect(engineFromStoredValue('claude')).toBe('claude');
    expect(engineFromStoredValue(' Codex ')).toBe('codex');
  });

  it('falls back for anything it cannot parse, without throwing', () => {
    expect(engineFromStoredValue('gemini')).toBe('codex');
    expect(engineFromStoredValue(null)).toBe('codex');
    expect(engineFromStoredValue(undefined, 'claude')).toBe('claude');
  });
});

describe('parseEngine', () => {
  it('falls back only for an absent value', () => {
    expect(parseEngine(undefined)).toBe('codex');
    expect(parseEngine(null, 'claude')).toBe('claude');
    expect(parseEngine('', 'claude')).toBe('claude');
  });

  it('rejects a present value that is not an engine', () => {
    for (const value of ['gemini', 'clude', 'codex,claude', 7, true, {}, ['codex']]) {
      expect(() => parseEngine(value)).toThrow(/engine must be "codex" or "claude"/);
    }
  });
});

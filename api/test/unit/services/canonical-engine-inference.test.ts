import { describe, expect, it } from 'vitest';
import {
  assertCanonicalEngineConsistent,
  createRunnerValidationService,
  inferCanonicalEngine,
  type NormalizedAuthEntry,
} from '../../../src/services/runner-validation.js';
import { createDbFake } from '../../helpers/db-fake.js';

/**
 * `inferCanonicalEngine` used to read:
 *
 *     return hasAnthropic && !hasOpenAi ? ENGINE_CLAUDE : ENGINE_CODEX;
 *
 * so *every* case it could not tell apart came back Codex — an empty payload, a
 * payload with no native credential at all, and a payload carrying both an
 * OpenAI and an Anthropic credential. The last one is the damaging shape: a
 * dual-credential upload with no explicit engine was filed as the Codex
 * canonical head, the Anthropic half was filtered away by
 * `canonicalizeAuthPayload`, and the fleet's Codex credential was replaced by
 * something nobody had aimed at it.
 */

function entry(target: string, token = 'a'.repeat(40)): NormalizedAuthEntry {
  return {
    target,
    token,
    tokenType: 'bearer',
    organization: null,
    project: null,
    apiBase: null,
    meta: null,
  };
}

const OPENAI = entry('api.openai.com');
const ANTHROPIC = entry('api.anthropic.com');

describe('inferCanonicalEngine', () => {
  it('resolves a single-family payload', () => {
    expect(inferCanonicalEngine([OPENAI])).toBe('codex');
    expect(inferCanonicalEngine([ANTHROPIC])).toBe('claude');
  });

  it('refuses to guess when both families are present', () => {
    expect(inferCanonicalEngine([OPENAI, ANTHROPIC])).toBeNull();
    expect(inferCanonicalEngine([ANTHROPIC, OPENAI])).toBeNull();
  });

  it('refuses to guess when there is no native credential', () => {
    expect(inferCanonicalEngine([])).toBeNull();
    expect(inferCanonicalEngine([entry('api.example.com')])).toBeNull();
  });
});

describe('assertCanonicalEngineConsistent', () => {
  it('accepts entries that match the declared engine', () => {
    expect(() => assertCanonicalEngineConsistent([OPENAI], 'codex')).not.toThrow();
    expect(() => assertCanonicalEngineConsistent([ANTHROPIC], 'claude')).not.toThrow();
  });

  it('accepts an empty entry set, which carries no contradiction', () => {
    expect(() => assertCanonicalEngineConsistent([], 'codex')).not.toThrow();
    expect(() => assertCanonicalEngineConsistent([], 'claude')).not.toThrow();
  });

  it('rejects a record whose credentials belong to the other engine', () => {
    expect(() => assertCanonicalEngineConsistent([ANTHROPIC], 'codex')).toThrow(
      /declared engine codex but carries api\.anthropic\.com credentials/,
    );
    expect(() => assertCanonicalEngineConsistent([OPENAI], 'claude')).toThrow(
      /declared engine claude but carries api\.openai\.com credentials/,
    );
  });

  it('rejects cross-engine entries inside a single-engine record', () => {
    for (const engine of ['codex', 'claude'] as const) {
      expect(() => assertCanonicalEngineConsistent([OPENAI, ANTHROPIC], engine)).toThrow(
        /credentials/,
      );
    }
  });
});

describe('canonicalizeAuthPayload requires an explicit, consistent engine', () => {
  function validation() {
    return createRunnerValidationService({ db: createDbFake() as never, tokenMinLength: 8 });
  }

  it('canonicalizes a matching single-engine payload', () => {
    const service = validation();
    const payload = { auths: { 'api.openai.com': { token: 'sk-openai-valid-token' } } };
    const canonical = service.canonicalizeAuthPayload(
      payload,
      service.normalizeAuthEntries(payload, 'codex'),
      '2026-05-20T10:00:00Z',
      'codex',
    );
    expect(canonical).toMatchObject({ last_refresh: '2026-05-20T10:00:00Z' });
    expect(Object.keys(canonical.auths as object)).toEqual(['api.openai.com']);
  });

  it('rejects a mixed payload rather than silently dropping the other engine', () => {
    const service = validation();
    // Entries built for `codex` would already be filtered, so this hands the
    // canonicalizer the mixed set directly — which is exactly what a caller
    // that assembled entries itself would do.
    expect(() =>
      service.canonicalizeAuthPayload(
        {},
        [OPENAI, ANTHROPIC],
        '2026-05-20T10:00:00Z',
        'codex',
      ),
    ).toThrow(/carries api\.anthropic\.com credentials/);
  });

  it('rejects a payload filed under the engine it does not belong to', () => {
    const service = validation();
    expect(() =>
      service.canonicalizeAuthPayload({}, [ANTHROPIC], '2026-05-20T10:00:00Z', 'codex'),
    ).toThrow(/declared engine codex/);
  });
});

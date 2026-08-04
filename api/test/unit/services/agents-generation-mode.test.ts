import { describe, expect, it } from 'vitest';
import {
  AGENTS_GENERATION_MODES,
  baseBodyForMode,
  compositionForMode,
  normalizeAgentsGenerationMode,
  parseAgentsGenerationMode,
} from '../../../src/services/agents-generation-mode.js';
import { defaultAgentPolicyComposition } from '../../../src/services/agent-policy-composer.js';

function builderState(customInstructions: string): Record<string, unknown> {
  return { ...defaultAgentPolicyComposition(), custom_instructions: customInstructions };
}

describe('agents generation mode normalization', () => {
  it('offers exactly the three documented positions', () => {
    expect(AGENTS_GENERATION_MODES).toEqual(['managed', 'manual', 'off']);
  });

  it('accepts each mode, case- and whitespace-insensitively', () => {
    expect(parseAgentsGenerationMode('managed')).toBe('managed');
    expect(parseAgentsGenerationMode(' Manual ')).toBe('manual');
    expect(parseAgentsGenerationMode('OFF')).toBe('off');
  });

  // The write path has to be strict so an operator typo is a 400 rather than a
  // silent fleet-wide reset to `managed`.
  it('rejects anything else on the write path', () => {
    for (const value of [null, undefined, '', 'disabled', 'generated', 1, true, {}]) {
      expect(parseAgentsGenerationMode(value)).toBeNull();
    }
  });

  // The read path is the dangerous direction: a value this build does not know
  // must never be read as "stop generating" for every host at once.
  it('fails open to managed on the read path', () => {
    for (const value of [null, undefined, '', '1', 'disabled', 'a-mode-from-a-later-version', 42]) {
      expect(normalizeAgentsGenerationMode(value)).toBe('managed');
    }
    expect(normalizeAgentsGenerationMode('off')).toBe('off');
  });
});

describe('compositionForMode', () => {
  it('passes a draft through untouched outside off', () => {
    const draft = builderState('house rules');
    expect(compositionForMode('managed', draft)).toBe(draft);
    expect(compositionForMode('manual', draft)).toBe(draft);
  });

  it('drops the generated modules and keeps custom instructions at off', () => {
    const out = compositionForMode('off', builderState('house rules')) as Record<string, unknown>;
    expect(out['enabled_modules']).toEqual([]);
    expect(out['custom_instructions']).toBe('house rules');
  });

  it('rejects a malformed draft rather than silently emptying it', () => {
    expect(() => compositionForMode('off', { schema_version: 2 })).toThrow();
  });
});

describe('baseBodyForMode', () => {
  const body = '## Operating Contract (FAST)\n\nstored bytes\n';

  it('serves the stored body unchanged outside off', () => {
    const row = { body, builderState: builderState('house rules') };
    expect(baseBodyForMode('managed', row)).toBe(body);
    expect(baseBodyForMode('manual', row)).toBe(body);
  });

  it('recomposes a builder document down to its custom instructions at off', () => {
    const out = baseBodyForMode('off', { body, builderState: builderState('house rules') });
    expect(out).toBe('## Custom Instructions\n\nhouse rules\n');
    expect(out).not.toContain('Operating Contract');
  });

  it('renders nothing at off when the builder document has no custom instructions', () => {
    expect(baseBodyForMode('off', { body, builderState: builderState('') })).toBe('');
  });

  // Nothing in a hand-written body was generated, so `off` has nothing to drop.
  it('serves a hand-written body unchanged at off', () => {
    expect(baseBodyForMode('off', { body, builderState: null })).toBe(body);
  });

  // Suppressing fleet-wide prose on the strength of a JSON column we failed to
  // parse is the same fail-closed mistake the mode normalizer avoids.
  it('serves the stored body at off when the builder state cannot be parsed', () => {
    expect(baseBodyForMode('off', { body, builderState: { schema_version: 99 } })).toBe(body);
    expect(baseBodyForMode('off', { body, builderState: 'not json' })).toBe(body);
  });
});

import { describe, expect, it } from 'vitest';

import type { Host } from '../../../src/db/schema.js';
import { ForbiddenError } from '../../../src/http/errors.js';
import { assertHostEngineEnabled, hostEnginesList } from '../../../src/services/host-engine-policy.js';

const hostWith = (engines: unknown): Host => ({ id: 1, fqdn: 'host.example', engines }) as unknown as Host;

describe('hostEnginesList', () => {
  it('preserves the order the column lists engines in', () => {
    expect(hostEnginesList('codex,claude')).toEqual(['codex', 'claude']);
    expect(hostEnginesList('claude,codex')).toEqual(['claude', 'codex']);
  });

  it('trims and case-folds each part', () => {
    expect(hostEnginesList(' CODEX , Claude ')).toEqual(['codex', 'claude']);
  });

  it('collapses duplicates', () => {
    expect(hostEnginesList('codex,codex')).toEqual(['codex']);
    expect(hostEnginesList('claude,codex,claude,codex')).toEqual(['claude', 'codex']);
  });

  it('drops unknown parts but keeps the recognised ones', () => {
    expect(hostEnginesList('claude,gemini')).toEqual(['claude']);
    expect(hostEnginesList('codex,,claude')).toEqual(['codex', 'claude']);
  });

  it('falls back to codex for empty, blank, absent or wholly unrecognised values', () => {
    // A blanked column re-enables codex rather than locking the host out entirely.
    expect(hostEnginesList('')).toEqual(['codex']);
    expect(hostEnginesList('   ')).toEqual(['codex']);
    expect(hostEnginesList(null)).toEqual(['codex']);
    expect(hostEnginesList(undefined)).toEqual(['codex']);
    expect(hostEnginesList('gemini,llama')).toEqual(['codex']);
  });
});

describe('assertHostEngineEnabled', () => {
  it('returns void when the engine is listed', () => {
    expect(assertHostEngineEnabled(hostWith('codex,claude'), 'claude')).toBeUndefined();
    expect(assertHostEngineEnabled(hostWith('claude'), 'claude')).toBeUndefined();
    expect(assertHostEngineEnabled(hostWith('codex'), 'codex')).toBeUndefined();
  });

  it('throws a ForbiddenError with code engine_disabled when the engine is not listed', () => {
    expect(() => assertHostEngineEnabled(hostWith('codex'), 'claude')).toThrow(ForbiddenError);
    try {
      assertHostEngineEnabled(hostWith('codex'), 'claude');
      expect.unreachable('expected assertHostEngineEnabled to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).code).toBe('engine_disabled');
      expect((err as ForbiddenError).status).toBe(403);
      expect((err as ForbiddenError).message).toContain('claude');
    }
  });

  it('rejects claude on a host whose engines column is blank', () => {
    // The '' fallback is ['codex'], so claude stays disabled there.
    expect(() => assertHostEngineEnabled(hostWith(''), 'claude')).toThrow(ForbiddenError);
    expect(() => assertHostEngineEnabled(hostWith(null), 'claude')).toThrow(/engine claude is disabled/i);
    expect(assertHostEngineEnabled(hostWith(''), 'codex')).toBeUndefined();
  });
});

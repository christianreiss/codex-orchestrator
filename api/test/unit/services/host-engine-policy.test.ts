import { describe, expect, it } from 'vitest';

import type { Host } from '../../../src/db/schema.js';
import { ConflictError, ForbiddenError } from '../../../src/http/errors.js';
import {
  ALL_ENGINES_ENABLED,
  activeHostEngines,
  assertHostEngineAssigned,
  assertHostEngineEnabled,
  disabledEngines,
  enabledEngines,
  fleetEngineConflictError,
  hostEnginesList,
  type FleetEngineState,
} from '../../../src/services/host-engine-policy.js';

const ALL = ALL_ENGINES_ENABLED;
const CLAUDE_OFF: FleetEngineState = { codex: true, claude: false, grok: true };

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
    expect(assertHostEngineEnabled(hostWith('codex,claude'), 'claude', ALL)).toBeUndefined();
    expect(assertHostEngineEnabled(hostWith('claude'), 'claude', ALL)).toBeUndefined();
    expect(assertHostEngineEnabled(hostWith('codex'), 'codex', ALL)).toBeUndefined();
  });

  it('throws a ForbiddenError with code engine_disabled when the engine is not listed', () => {
    expect(() => assertHostEngineEnabled(hostWith('codex'), 'claude', ALL)).toThrow(ForbiddenError);
    try {
      assertHostEngineEnabled(hostWith('codex'), 'claude', ALL);
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
    expect(() => assertHostEngineEnabled(hostWith(''), 'claude', ALL)).toThrow(ForbiddenError);
    expect(() => assertHostEngineEnabled(hostWith(null), 'claude', ALL)).toThrow(/engine claude is disabled/i);
    expect(assertHostEngineEnabled(hostWith(''), 'codex', ALL)).toBeUndefined();
  });
});

describe('fleet engine switch', () => {
  const refusal = (fn: () => void): ForbiddenError => {
    try {
      fn();
    } catch (err) {
      return err as ForbiddenError;
    }
    throw new Error('expected a refusal');
  };

  it('refuses an assigned engine that is switched off fleet-wide, with scope fleet', () => {
    const err = refusal(() => assertHostEngineEnabled(hostWith('codex,claude'), 'claude', CLAUDE_OFF));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.status).toBe(403);
    expect(err.code).toBe('engine_disabled');
    expect(err.toJSON()).toMatchObject({ scope: 'fleet', engine: 'claude' });
    expect(err.message).toMatch(/Claude is disabled fleet-wide/);
  });

  it('reports a host-level removal as scope host even while the fleet switch is off too', () => {
    // Wrappers clean up a host-scope refusal but must keep their config through
    // a fleet one, so the host check has to win.
    const err = refusal(() => assertHostEngineEnabled(hostWith('codex'), 'claude', CLAUDE_OFF));
    expect(err.code).toBe('engine_disabled');
    expect(err.toJSON()).toMatchObject({ scope: 'host', engine: 'claude' });
  });

  it('leaves the other engines alone', () => {
    expect(assertHostEngineEnabled(hostWith('codex,claude'), 'codex', CLAUDE_OFF)).toBeUndefined();
  });

  it('assertHostEngineAssigned ignores the fleet switch', () => {
    expect(assertHostEngineAssigned(hostWith('codex,claude'), 'claude')).toBeUndefined();
    expect(() => assertHostEngineAssigned(hostWith('codex'), 'claude')).toThrow(ForbiddenError);
  });

  it('activeHostEngines never falls back to codex', () => {
    expect(activeHostEngines('claude', CLAUDE_OFF)).toEqual([]);
    expect(activeHostEngines('codex,claude', CLAUDE_OFF)).toEqual(['codex']);
    expect(activeHostEngines('codex,claude', ALL)).toEqual(['codex', 'claude']);
  });

  it('lists disabled and enabled engines in canonical order', () => {
    expect(disabledEngines(CLAUDE_OFF)).toEqual(['claude']);
    expect(enabledEngines(CLAUDE_OFF)).toEqual(['codex', 'grok']);
    expect(disabledEngines(ALL)).toEqual([]);
  });

  it('admin conflicts are 409 engine_disabled with scope fleet', () => {
    const err = fleetEngineConflictError('grok');
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('engine_disabled');
    expect(err.toJSON()).toMatchObject({ scope: 'fleet', engine: 'grok' });
  });
});

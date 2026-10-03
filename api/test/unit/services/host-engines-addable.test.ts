import { describe, expect, it } from 'vitest';
import { ConflictError } from '../../../src/http/errors.js';
import { assertEnginesAddable } from '../../../src/services/host-management.js';
import type { FleetEngineState } from '../../../src/services/host-engine-policy.js';

const GROK_OFF: FleetEngineState = { codex: true, claude: true, grok: false };

describe('assertEnginesAddable', () => {
  it('refuses to newly assign an engine switched off fleet-wide', () => {
    expect(() => assertEnginesAddable(['codex', 'grok'], ['codex'], GROK_OFF)).toThrow(ConflictError);
    try {
      assertEnginesAddable(['grok'], [], GROK_OFF);
    } catch (err) {
      expect((err as ConflictError).status).toBe(409);
      expect((err as ConflictError).toJSON()).toMatchObject({ code: 'engine_disabled', scope: 'fleet', engine: 'grok' });
    }
  });

  it('lets an already-assigned suspended engine stay, so unrelated edits still save', () => {
    expect(() => assertEnginesAddable(['codex', 'grok'], ['codex', 'grok'], GROK_OFF)).not.toThrow();
    // Removing it is always fine.
    expect(() => assertEnginesAddable(['codex'], ['codex', 'grok'], GROK_OFF)).not.toThrow();
  });

  it('allows enabled engines freely', () => {
    expect(() => assertEnginesAddable(['codex', 'claude'], [], GROK_OFF)).not.toThrow();
  });
});
